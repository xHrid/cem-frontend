"""
CEM Toolkit — Global Watcher
Monitors project job queues, executes analysis scripts in an isolated venv,
and keeps the system heartbeat alive.

Architecture: WatcherConfig → WatcherSetup → WatcherLoop
"""

import argparse
import hashlib
import json
import logging
import os
import signal
import subprocess
import sys
import threading
import time
import urllib.request
import ssl
import platform
import shutil
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Optional
import re as _re

_ssl_ctx = ssl.create_default_context()
try:
    import certifi
    _ssl_ctx.load_verify_locations(cafile=certifi.where())
except ImportError:
    pass

_opener = urllib.request.build_opener(
    urllib.request.HTTPSHandler(context=_ssl_ctx),
    urllib.request.ProxyHandler(),
)
urllib.request.install_opener(_opener)

_IS_WSL = Path('/mnt').is_dir() and sys.platform != "darwin"
_IS_WINDOWS = sys.platform == "win32"

def _normalize_path(path_str: str) -> str:
    """Normalize a path for the *current* OS, handling cross-platform inputs.

    Webapp stores paths with forward slashes (JS).  Windows uses backslashes.
    WSL needs /mnt/d/... form.  This function accepts ANY mix and returns
    a consistent native path string.

    Rules:
      - WSL  + Windows path  → /mnt/<drive>/...   (forward slashes)
      - Windows + any path   → os.sep backslashes  (via Path)
      - Linux/Mac + POSIX    → unchanged
    """
    if not path_str:
        return path_str

    norm = path_str.replace('\\', '/')

    m = _re.match(r'^([A-Za-z]):(/.*)?$', norm)

    if m and _IS_WSL:
        drive = m.group(1).lower()
        rest  = m.group(2) or ''
        return f'/mnt/{drive}{rest}'

    if _IS_WINDOWS:
        return str(Path(norm))

    return norm

_win_to_wsl = _normalize_path

# While a job runs, refresh the heartbeat at least this often so the UI can tell
# "still working" from "died mid-job". Must stay well below the UI's stale window.
_HEARTBEAT_REFRESH_SEC = 10

# A queued descriptor is created (0 bytes) and filled in a separate write/close on
# the UI side. If we catch it before the content lands, wait this long before
# treating an empty file as a genuine failure.
_QUEUE_SETTLE_GRACE = 5.0

_AUDIO_EXTS = frozenset({'.wav', '.mp3', '.flac', '.ogg', '.opus', '.m4a', '.wma', '.aac'})

def _count_audio_files(directory: str) -> int:
    """Count audio files recursively in a directory (for progress estimation)."""
    try:
        return sum(
            1 for f in Path(directory).rglob('*')
            if f.suffix.lower() in _AUDIO_EXTS
        )
    except (OSError, PermissionError):
        return 0

@dataclass
class WatcherConfig:
    root_path: Path
    watch_interval: int = 2
    job_timeout: int = 1800
    pip_timeout: Optional[int] = None
    heartbeat_file: str = "system/status.json"
    scripts_dir: str = "system/scripts"
    installed_registry: str = "system/scripts/installed.json"
    venv_dir: str = "system/.venv"
    lock_file: str = "system/watcher.lock"
    req_hash_file: str = "system/.req_hash"
    github_repo_url: str = (
        "https://raw.githubusercontent.com/xHrid/cem-backend/master"
    )

    status_path: Path = field(init=False)
    scripts_path: Path = field(init=False)
    venv_path: Path = field(init=False)
    lock_path: Path = field(init=False)
    req_hash_path: Path = field(init=False)
    installed_registry_path: Path = field(init=False)

    def __post_init__(self) -> None:
        self.status_path = self.root_path / self.heartbeat_file
        self.scripts_path = self.root_path / self.scripts_dir
        self.venv_path = self.root_path / self.venv_dir
        self.lock_path = self.root_path / self.lock_file
        self.req_hash_path = self.root_path / self.req_hash_file
        self.installed_registry_path = self.root_path / self.installed_registry

    @property
    def venv_python(self) -> str:
        if os.name == "nt":
            return str(self.venv_path / "Scripts" / "python.exe")
        return str(self.venv_path / "bin" / "python")

def build_logger(name: str = "cem_watcher") -> logging.Logger:
    logger = logging.getLogger(name)
    if logger.handlers:
        return logger

    logger.setLevel(logging.DEBUG)
    handler = logging.StreamHandler(sys.stdout)
    handler.setLevel(logging.DEBUG)
    fmt = logging.Formatter("[%(asctime)s] %(levelname)-8s %(message)s", datefmt="%H:%M:%S")
    handler.setFormatter(fmt)
    logger.addHandler(handler)
    return logger

logger = build_logger()

class LockFile:
    """PID-based lock file.  Acquired on __enter__, released on __exit__."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self._acquired = False

    @staticmethod
    def _proc_start_time(pid: int):
        """Kernel start time (jiffies since boot) for *pid*, or None if unknown.

        Lets us tell a still-running watcher apart from an unrelated process the
        OS handed the same PID after an uncleaned crash (PID reuse). Linux/WSL
        only; returns None elsewhere (callers fall back to a plain liveness test).
        """
        try:
            with open(f"/proc/{pid}/stat", "r") as fh:
                data = fh.read()
            # comm (field 2) is parenthesised and may contain spaces or ')',
            # so the numeric fields resume right after the final ')'.
            after = data[data.rindex(")") + 1:].split()
            return int(after[19])  # field 22 = starttime
        except (OSError, ValueError, IndexError):
            return None

    def _read_lock(self):
        """Return (pid, start_time) from the lock file.

        Tolerates the legacy plain-integer format (start_time None) so an
        existing lock from an older build is still understood.
        """
        try:
            raw = self.path.read_text().strip()
        except OSError:
            return None, None
        try:
            obj = json.loads(raw)
            return int(obj["pid"]), obj.get("start")
        except (ValueError, KeyError, TypeError):
            try:
                return int(raw), None
            except ValueError:
                return None, None

    def _stale(self) -> bool:
        """Return True if the lock's recorded process is no longer running.

        Also True when the PID is alive but its start time no longer matches what
        we recorded — i.e. the OS reused the PID — so a stale lock left by a crash
        can't permanently block startup ("Another watcher is already running").
        """
        pid, recorded_start = self._read_lock()
        if pid is None:
            return True

        if os.name == "nt":
            import ctypes
            handle = ctypes.windll.kernel32.OpenProcess(0x1000, False, pid)
            if handle:
                ctypes.windll.kernel32.CloseHandle(handle)
                return False
            return True

        try:
            os.kill(pid, 0)
        except OSError:
            return True  # no such process

        # PID is alive — if we recorded a start time and can read the current
        # one, a mismatch means this is a different process (PID reuse).
        if recorded_start is not None:
            current_start = self._proc_start_time(pid)
            if current_start is not None and current_start != recorded_start:
                return True
        return False

    def acquire(self) -> bool:
        if self.path.exists() and not self._stale():
            existing_pid, _ = self._read_lock()
            logger.error(
                "Another watcher instance is already running (PID %s). "
                "Remove %s to force-start.",
                existing_pid,
                self.path,
            )
            return False
        self.path.parent.mkdir(parents=True, exist_ok=True)
        my_pid = os.getpid()
        self.path.write_text(json.dumps({"pid": my_pid, "start": self._proc_start_time(my_pid)}))
        self._acquired = True
        return True

    def release(self) -> None:
        if self._acquired and self.path.exists():
            try:
                self.path.unlink()
            except OSError as exc:
                logger.warning("Could not remove lock file: %s", exc)
            self._acquired = False

    def __enter__(self) -> "LockFile":
        if not self.acquire():
            raise RuntimeError("Failed to acquire watcher lock.")
        return self

    def __exit__(self, *_) -> None:
        self.release()

class WatcherSetup:
    def __init__(self, cfg: WatcherConfig) -> None:
        self.cfg = cfg

    def update_heartbeat(self, current_status: str = "online") -> None:
        cfg = self.cfg
        cfg.status_path.parent.mkdir(parents=True, exist_ok=True)
        data = {
            "status": current_status,
            "last_active_ts": time.time(),
            "worker_pid": os.getpid(),
            "root_path": str(cfg.root_path),
        }
        try:
            tmp = cfg.status_path.with_suffix(".tmp")
            with open(tmp, "w") as fh:
                json.dump(data, fh)
            tmp.replace(cfg.status_path)
        except Exception as exc:
            logger.warning("Error updating heartbeat: %s", exc)

    def remove_heartbeat(self) -> None:
        try:
            if self.cfg.status_path.exists():
                self.cfg.status_path.unlink()
        except OSError as exc:
            logger.warning("Could not remove heartbeat file: %s", exc)

    @staticmethod
    def _file_sha256(path: Path) -> str:
        h = hashlib.sha256()
        with open(path, "rb") as fh:
            for chunk in iter(lambda: fh.read(65536), b""):
                h.update(chunk)
        return h.hexdigest()

    def setup_virtual_environment(self) -> None:
        cfg = self.cfg

        if not cfg.venv_path.exists():
            logger.info("Creating isolated Virtual Environment...")
            self.update_heartbeat("installing_dependencies")
            subprocess.run(
                [sys.executable, "-m", "venv", str(cfg.venv_path)],
                check=True,
                timeout=300,
            )

        req_url = f"{cfg.github_repo_url}/requirements.txt"
        req_path = cfg.root_path / "system" / "requirements.txt"

        try:
            logger.info("Fetching latest requirements.txt from GitHub...")
            tmp_req = req_path.with_suffix(".tmp")
            urllib.request.urlretrieve(req_url, tmp_req)
            new_hash = self._file_sha256(tmp_req)

            stored_hash: Optional[str] = None
            if cfg.req_hash_path.exists():
                stored_hash = cfg.req_hash_path.read_text().strip()

            if new_hash == stored_hash and req_path.exists():
                logger.info("Requirements unchanged — skipping pip install.")
                tmp_req.unlink()
                return

            tmp_req.replace(req_path)
            logger.info("Installing dependencies in venv...")
            self.update_heartbeat("installing_dependencies")
            subprocess.run(
                [cfg.venv_python, "-m", "pip", "install",
                 "--prefer-binary", "--no-input", "-r", str(req_path)],
                capture_output=True,
                text=True,
                check=True,
                timeout=cfg.pip_timeout,
            )
            cfg.req_hash_path.write_text(new_hash)
            logger.info("Environment setup complete.")
        except subprocess.CalledProcessError as exc:
            logger.error("Pip install failed (deps incomplete): %s", exc.stderr)
        except subprocess.TimeoutExpired:
            logger.error(
                "Pip install timed out after %ds — deps incomplete. "
                "Raise --pip-timeout (tensorflow+birdnetlib are large). "
                "Req hash NOT saved, so install retries on next start.",
                cfg.pip_timeout,
            )
        except Exception as exc:
            logger.warning("Failed to setup requirements: %s", exc)

    @staticmethod
    def _content_sha256(data: bytes) -> str:
        return hashlib.sha256(data).hexdigest()

    def sync_scripts(self) -> None:
        cfg = self.cfg
        logger.info("Checking for script updates from GitHub...")
        cfg.scripts_path.mkdir(parents=True, exist_ok=True)

        try:
            registry_url = f"{cfg.github_repo_url}/scripts.json"
            with urllib.request.urlopen(registry_url, timeout=30) as resp:
                script_folders = json.loads(resp.read().decode())
        except Exception as exc:
            logger.warning("Sync failed (using cached scripts if available): %s", exc)
            return

        installed_scripts = []
        for folder in script_folders:
            logger.info("  Syncing module: %s", folder)
            manifest_url = f"{cfg.github_repo_url}/{folder}/manifest.json"
            try:
                with urllib.request.urlopen(manifest_url, timeout=30) as resp:
                    manifest_data = json.loads(resp.read().decode())

                for script_entry in manifest_data:
                    self._sync_file(folder, script_entry["script_file"])

                    for asset in script_entry.get("assets", []):
                        self._sync_file(folder, asset)

                    installed_scripts.append(script_entry)
            except Exception as folder_err:
                logger.warning("  Skipping %s: %s", folder, folder_err)

        with open(cfg.installed_registry_path, "w") as fh:
            json.dump(installed_scripts, fh, indent=2)
        logger.info("Successfully synced %d analysis scripts.", len(installed_scripts))

    def _sync_file(self, folder: str, filename: str) -> None:
        """Download *filename* from *folder* if it is absent or its content hash differs.

        Integrity safeguards:
          - Validates Content-Length against actual bytes received
          - For .py files: verifies the source compiles (catches truncation)
          - Writes via atomic temp-file rename (no partial overwrites)
          - Deduplicates shared assets (e.g. 00_config.py) — first valid
            download wins; subsequent folders skip if hash matches
        """
        cfg = self.cfg
        remote_url = f"{cfg.github_repo_url}/{folder}/{filename}"
        local_path = cfg.scripts_path / filename

        try:
            with urllib.request.urlopen(remote_url, timeout=30) as resp:
                remote_bytes = resp.read()
                expected_len = resp.headers.get("Content-Length")
                if expected_len is not None:
                    expected_len = int(expected_len)
                    if len(remote_bytes) != expected_len:
                        logger.warning(
                            "    %s/%s: incomplete download (%d/%d bytes). Skipping.",
                            folder, filename, len(remote_bytes), expected_len,
                        )
                        return
        except Exception as exc:
            logger.warning("    Could not fetch %s/%s: %s", folder, filename, exc)
            return

        if filename.endswith(".py"):
            try:
                compile(remote_bytes, filename, "exec")
            except SyntaxError as exc:
                logger.warning(
                    "    %s/%s: syntax error after download (line %s). "
                    "Keeping existing copy.",
                    folder, filename, exc.lineno,
                )
                return

        remote_hash = self._content_sha256(remote_bytes)

        if local_path.exists():
            local_hash = self._file_sha256(local_path)
            if local_hash == remote_hash:
                return
            logger.info("    Updating: %s (from %s)", filename, folder)
        else:
            logger.info("    Downloading: %s (from %s)", filename, folder)

        local_path.parent.mkdir(parents=True, exist_ok=True)
        tmp_path = local_path.with_suffix(local_path.suffix + ".tmp")
        tmp_path.write_bytes(remote_bytes)
        tmp_path.replace(local_path)

class JobProcessor:
    def __init__(self, cfg: WatcherConfig, setup: WatcherSetup) -> None:
        self.cfg = cfg
        self.setup = setup

    def _resolve_aggregate_path(
        self, script_name: str, db_dir: Path
    ) -> Optional[str]:
        """Look up aggregate_file from the script's manifest entry.

        Returns the absolute path to the aggregate CSV in the project's
        system/database/ directory, or None if the script has no aggregate.
        """
        cfg = self.cfg
        if not cfg.installed_registry_path.exists():
            return None

        try:
            with open(cfg.installed_registry_path, "r") as fh:
                installed = json.load(fh)
        except (json.JSONDecodeError, OSError):
            return None

        script_def = next(
            (s for s in installed if s.get("script_file") == script_name),
            None,
        )
        if not script_def:
            return None

        agg_name = script_def.get("aggregate_file")
        if agg_name:
            return str(db_dir / agg_name)

        master_name = script_def.get("outputs", {}).get("master_csv")
        if master_name:
            return str(db_dir / master_name)

        return None

    def process(self, job_file: Path) -> None:
        cfg = self.cfg
        job_id = job_file.stem

        if not job_id or job_id.startswith('.'):
            job_id = f"unnamed_job_{int(time.time())}"

        # Empty-file race: the UI creates the descriptor (0 bytes) and writes its
        # content in a separate step. If we observe it mid-write, skip and retry
        # next cycle instead of moving a valid, about-to-be-filled job to failed/.
        try:
            stat = job_file.stat()
        except OSError:
            return  # vanished between scan and now (e.g. UI deleted it)
        if stat.st_size == 0:
            if time.time() - stat.st_mtime < _QUEUE_SETTLE_GRACE:
                logger.debug("Job %s still being written (0 bytes) — retry next cycle", job_id)
                return
            logger.warning("Job %s empty after %.0fs — treating as failed", job_id, _QUEUE_SETTLE_GRACE)

        logger.info("Found Job: %s", job_id)

        project_root = job_file.parent.parent.parent
        processing_dir = project_root / "jobs" / "processing"
        completed_dir = project_root / "jobs" / "completed"
        results_dir = project_root / "jobs" / "results"
        failed_dir = project_root / "jobs" / "failed"
        db_dir = project_root / "system" / "database"

        for directory in (processing_dir, completed_dir, results_dir, failed_dir, db_dir):
            directory.mkdir(parents=True, exist_ok=True)

        processing_path = processing_dir / job_file.name
        shutil.move(str(job_file), str(processing_path))

        try:
            with open(processing_path, "r") as fh:
                job_data = json.load(fh)

            script_name = job_data.get("script_name", "core_script.py")
            params = job_data.get("parameters", {})

            script_path = (cfg.scripts_path / script_name).resolve()
            # Containment: resolve() happily escapes scripts_path for a name like
            # "../../x.py". script_name comes from a file in a shared folder, so
            # refuse anything that lands outside the managed scripts dir.
            try:
                script_path.relative_to(cfg.scripts_path.resolve())
            except ValueError:
                raise ValueError(f"Script path escapes scripts dir: {script_name}")
            if not script_path.exists():
                raise FileNotFoundError(f"Script not found: {script_name}")

            job_result_dir = results_dir / job_id
            job_result_dir.mkdir(parents=True, exist_ok=True)

            cmd = [cfg.venv_python, str(script_path)]

            cmd.extend(["--output-dir", str(job_result_dir)])
            cmd.extend(["--root-dir", str(cfg.root_path)])
            cmd.extend(["--project-dir", str(project_root)])

            raw_dataset_spots = job_data.get("dataset_spots", [])

            dir_to_spot = {}

            for idx, d in enumerate(job_data.get("datasets", [])):
                spot_label = raw_dataset_spots[idx] if idx < len(raw_dataset_spots) else ""
                norm_d = _normalize_path(d)
                p = (cfg.root_path / norm_d).resolve()
                if not p.exists():
                    p = Path(norm_d).resolve()
                if p.exists():
                    key = str(p)
                    if key not in dir_to_spot:
                        dir_to_spot[key] = spot_label
                else:
                    logger.warning("  ⚠ dataset dir not found: %s", d)

            ref_file_count = 0
            ref_missing    = 0
            for entry in job_data.get("input_files", []):
                if isinstance(entry, dict):
                    raw, spot = entry.get("path"), entry.get("spot", "")
                else:
                    raw, spot = entry, ""
                if not raw:
                    continue

                p = Path(_normalize_path(raw)).resolve()
                if p.exists():
                    parent = str(p.parent)
                    if parent not in dir_to_spot:
                        dir_to_spot[parent] = spot or ""
                    ref_file_count += 1
                else:
                    ref_missing += 1
                    logger.debug("  ref file not found: %s → %s", raw, p)

            if ref_missing:
                logger.warning(
                    "  ⚠ %d reference file(s) not found (check paths in master_data.json)",
                    ref_missing,
                )

            unique_dirs      = list(dir_to_spot.keys())
            unique_dir_spots = [dir_to_spot[d] for d in unique_dirs]

            job_tmp_dir = job_result_dir / "_tmp"
            job_tmp_dir.mkdir(parents=True, exist_ok=True)

            _INLINE_THRESHOLD = 50

            if unique_dirs:
                dirs_file = job_tmp_dir / "datasets.txt"
                dirs_file.write_text("\n".join(unique_dirs), encoding="utf-8")
                cmd.extend(["--datasets-file", str(dirs_file)])
                if len(unique_dirs) <= _INLINE_THRESHOLD:
                    cmd.extend(["--datasets"] + unique_dirs)

                spots_file = job_tmp_dir / "dataset_spots.txt"
                spots_file.write_text(
                    "\n".join(s or "_" for s in unique_dir_spots),
                    encoding="utf-8",
                )
                cmd.extend(["--dataset-spots-file", str(spots_file)])
                if len(unique_dir_spots) <= _INLINE_THRESHOLD:
                    cmd.extend(["--dataset-spots"] + [s or "_" for s in unique_dir_spots])

            for key, val in params.items():
                cmd.extend([f"--{key.replace('_', '-')}", str(val)])

            noise_file = (cfg.scripts_path / "static_noise.wav").resolve()
            if noise_file.exists():
                cmd.extend(["--noise-path", str(noise_file)])
            rain_file = (cfg.scripts_path / "rain_noise.wav").resolve()
            if rain_file.exists():
                cmd.extend(["--rain-path", str(rain_file)])
            ebird_file = (cfg.scripts_path / "ebird_checklist.txt").resolve()
            if ebird_file.exists():
                cmd.extend(["--ebird-file", str(ebird_file)])

            aggregate_path = self._resolve_aggregate_path(script_name, db_dir)
            if aggregate_path:
                cmd.extend(["--aggregate-file", aggregate_path])
                logger.info("  Aggregate: %s", aggregate_path)
            script_stem = Path(script_name).stem
            processed_path = str(db_dir / f"processed_{script_stem}.txt")
            cmd.extend(["--processed-file", processed_path])

            logger.info("  Scanning input directories for audio files...")
            total_files = sum(_count_audio_files(d) for d in unique_dirs)
            spot_names = sorted(set(s for s in unique_dir_spots if s and s != "_"))

            if total_files == 0 and unique_dirs:
                logger.warning(
                    "  ⚠ 0 audio files found in %d dirs — check paths and file extensions",
                    len(unique_dirs),
                )
                for d in unique_dirs[:5]:
                    logger.warning("    dir: %s (exists: %s)", d, Path(d).exists())

            logger.info("  ┌─ Job Summary ─────────────────────────────")
            logger.info("  │ Script:          %s", script_name)
            logger.info("  │ Input dirs:      %d (from copies + reference parents)", len(unique_dirs))
            if ref_file_count:
                logger.info("  │ Reference files: %d included", ref_file_count)
            logger.info("  │ Total audio:     %d files to process", total_files)
            if spot_names:
                logger.info("  │ Spots:           %s", ", ".join(spot_names))
            param_strs = [f"{k}={v}" for k, v in params.items()]
            if param_strs:
                logger.info("  │ Params:          %s", ", ".join(param_strs))
            logger.info("  └─────────────────────────────────────────")
            logger.debug("  Full CMD: %s", " ".join(str(c) for c in cmd))
            self.setup.update_heartbeat("processing_job")

            stdout_log_path = job_result_dir / "stdout.log"

            logger.info("  ── Launching script ──────────────────────")
            start_time = time.time()

            with open(stdout_log_path, "w", encoding="utf-8") as log_fh:
                proc = subprocess.Popen(
                    cmd,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    cwd=str(script_path.parent),
                    text=True,
                    bufsize=1,
                )

                # Drain stdout on a background thread. Doing it inline blocks until
                # the child *closes* stdout (i.e. exits), so a hung child that never
                # exits would never reach proc.wait() and the timeout below would
                # never fire — freezing the whole single-threaded watcher.
                def _drain() -> None:
                    try:
                        for line in proc.stdout:
                            log_fh.write(line)
                    except (ValueError, OSError):
                        pass  # log file closed during shutdown/kill

                drain_thread = threading.Thread(target=_drain, daemon=True)
                drain_thread.start()

                # Wait in short slices so we can (a) enforce job_timeout even on a
                # silently-hung child and (b) refresh the heartbeat so the UI sees
                # the job as alive for its full (possibly long) duration.
                deadline = start_time + cfg.job_timeout
                try:
                    while True:
                        remaining = deadline - time.time()
                        if remaining <= 0:
                            raise subprocess.TimeoutExpired(cmd, cfg.job_timeout)
                        try:
                            proc.wait(timeout=min(remaining, _HEARTBEAT_REFRESH_SEC))
                            break
                        except subprocess.TimeoutExpired:
                            self.setup.update_heartbeat("processing_job")
                finally:
                    drain_thread.join(timeout=5)

            execution_duration = time.time() - start_time
            logger.info("  ─────────────────────────────────────────")

            if job_tmp_dir.exists():
                shutil.rmtree(job_tmp_dir, ignore_errors=True)

            elapsed_m, elapsed_s = divmod(int(execution_duration), 60)

            if proc.returncode == 0:
                rate = total_files / max(execution_duration, 0.1)
                logger.info(
                    "  ✅ Done! %d files in %dm%02ds (%.1f files/sec)",
                    total_files, elapsed_m, elapsed_s, rate,
                )

                stats_data = {
                    "execution_time_seconds": execution_duration,
                    "execution_time_formatted": f"{elapsed_m}m {elapsed_s}s",
                    "files_processed": total_files,
                    "files_per_second": round(rate, 2),
                }
                with open(job_result_dir / "run_stats.json", "w") as fh:
                    json.dump(stats_data, fh)

                shutil.move(
                    str(processing_path),
                    str(completed_dir / job_file.name),
                )
            else:
                logger.error(
                    "  ❌ Failed after %dm%02ds (code %d)",
                    elapsed_m, elapsed_s, proc.returncode,
                )
                error_log = job_result_dir / "error.log"
                if stdout_log_path.exists():
                    shutil.copy2(str(stdout_log_path), str(error_log))
                raise RuntimeError("Script execution failed. Check error.log")

        except subprocess.TimeoutExpired:
            logger.error("  Job %s timed out after %ds", job_id, cfg.job_timeout)
            if 'proc' in locals():
                proc.kill()
                proc.wait()
            self._write_failure_reason(
                results_dir / job_id,
                f"Job exceeded the time limit ({cfg.job_timeout}s) and was terminated.",
            )
            if processing_path.exists():
                shutil.move(str(processing_path), str(failed_dir / job_file.name))
        except Exception as exc:
            logger.error("  Job failed: %s", exc)
            self._write_failure_reason(
                results_dir / job_id,
                f"Job failed before or during execution:\n{exc}",
            )
            if processing_path.exists():
                shutil.move(str(processing_path), str(failed_dir / job_file.name))

    @staticmethod
    def _write_failure_reason(job_result_dir: Path, message: str) -> None:
        """Write error.log so the dashboard has something to show for a failed job.

        Never clobbers an existing error.log (the script's own copied stdout).
        """
        try:
            err_path = job_result_dir / "error.log"
            if err_path.exists():
                return
            job_result_dir.mkdir(parents=True, exist_ok=True)
            err_path.write_text(message + "\n", encoding="utf-8")
        except OSError:
            pass

class Watcher:
    def __init__(self, cfg: WatcherConfig) -> None:
        self.cfg = cfg
        self.setup = WatcherSetup(cfg)
        self.processor = JobProcessor(cfg, self.setup)
        self._running = False

    def _handle_signal(self, signum, _frame) -> None:
        sig_name = signal.Signals(signum).name if hasattr(signal, "Signals") else str(signum)
        logger.info("Received %s — shutting down gracefully...", sig_name)
        self._running = False

    def _register_signals(self) -> None:
        signal.signal(signal.SIGINT, self._handle_signal)
        if hasattr(signal, "SIGTERM"):
            signal.signal(signal.SIGTERM, self._handle_signal)
        if hasattr(signal, "SIGHUP"):
            signal.signal(signal.SIGHUP, signal.SIG_IGN)

    @staticmethod
    def _safe_mtime(f: Path) -> float:
        """mtime for sorting; missing files sort last instead of raising.

        glob() materialises the list, then the sort stat()s each path. A file the
        UI deleted (or we just moved) in between would otherwise raise
        FileNotFoundError mid-sort and crash the loop.
        """
        try:
            return f.stat().st_mtime
        except OSError:
            return float("inf")

    def _reclaim_orphaned_processing(self) -> None:
        """Fail jobs stranded in processing/ by a previous crash or restart.

        The loop only scans queue/, so a job interrupted mid-run (crash, reboot,
        machine sleep) would otherwise show 'Processing…' in the UI forever. We
        hold the lock, so no other watcher owns these — move each to failed/ with
        an error.log so the user gets a clear, re-runnable failure.
        """
        for proc_dir in self.cfg.root_path.glob("*/jobs/processing"):
            for job_file in proc_dir.glob("*.json"):
                try:
                    project_root = job_file.parent.parent.parent
                    failed_dir = project_root / "jobs" / "failed"
                    failed_dir.mkdir(parents=True, exist_ok=True)
                    JobProcessor._write_failure_reason(
                        project_root / "jobs" / "results" / job_file.stem,
                        "Job was interrupted by a watcher restart or crash and "
                        "could not be resumed. Please re-run it.",
                    )
                    shutil.move(str(job_file), str(failed_dir / job_file.name))
                    logger.warning("Reclaimed orphaned job %s → failed/", job_file.stem)
                except Exception as exc:
                    logger.warning("Could not reclaim orphaned job %s: %s", job_file, exc)

    def run(self) -> None:
        cfg = self.cfg
        lock = LockFile(cfg.lock_path)

        try:
            with lock:
                self._register_signals()
                logger.info("--- CEM Global Watcher Started (PID %d) ---", os.getpid())
                logger.info("Root path: %s", cfg.root_path)

                self.setup.setup_virtual_environment()
                self.setup.update_heartbeat("syncing_scripts")
                self.setup.sync_scripts()

                self._reclaim_orphaned_processing()

                self._running = True
                while self._running:
                    # Never let one bad job (vanished file, unexpected error) kill
                    # the daemon — log and keep serving the queue.
                    try:
                        self.setup.update_heartbeat("online")
                        job_files = sorted(
                            cfg.root_path.glob("*/jobs/queue/*.json"),
                            key=self._safe_mtime,
                        )
                        if job_files:
                            self.processor.process(job_files[0])
                    except Exception:
                        logger.exception("Unexpected error in watch loop — continuing")
                    time.sleep(cfg.watch_interval)

        except RuntimeError as exc:
            logger.error("%s", exc)
            sys.exit(1)
        finally:
            logger.info("Watcher stopped. Cleaning up...")
            self.setup.remove_heartbeat()

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="CEM Toolkit — Global Watcher",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument(
        "--root-path",
        type=Path,
        default=Path.cwd(),
        help="Root directory of the CEM Toolkit project (defaults to cwd).",
    )
    parser.add_argument(
        "--watch-interval",
        type=int,
        default=2,
        help="Seconds between queue scans.",
    )
    parser.add_argument(
        "--job-timeout",
        type=int,
        default=1800,
        help="Maximum seconds a single job script may run before being killed.",
    )
    parser.add_argument(
        "--pip-timeout",
        type=int,
        default=None,
        help="Max seconds for venv dependency install. Default: no timeout (deps are large).",
    )
    return parser.parse_args()

def main() -> None:
    args = parse_args()
    cfg = WatcherConfig(
        root_path=args.root_path.resolve(),
        watch_interval=args.watch_interval,
        job_timeout=args.job_timeout,
        pip_timeout=args.pip_timeout,
    )
    Watcher(cfg).run()

if __name__ == "__main__":
    main()
