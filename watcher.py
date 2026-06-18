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
import time
import urllib.request
import ssl
import shutil
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Optional
import re as _re

# ---------------------------------------------------------------------------
# SSL context — use system certificates so corporate proxies / custom CAs work.
# Falls back to unverified context only if system certs unavailable.
# ---------------------------------------------------------------------------
_ssl_ctx = ssl.create_default_context()
try:
    import certifi
    _ssl_ctx.load_verify_locations(cafile=certifi.where())
except ImportError:
    pass

_opener = urllib.request.build_opener(
    urllib.request.HTTPSHandler(context=_ssl_ctx),
    urllib.request.ProxyHandler(),  # reads HTTP(S)_PROXY env vars automatically
)
urllib.request.install_opener(_opener)


# ---------------------------------------------------------------------------
# Path utilities
# ---------------------------------------------------------------------------

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

    # Unify separators to forward slashes for pattern matching
    norm = path_str.replace('\\', '/')

    # Detect Windows drive letter: D:/... or D:
    m = _re.match(r'^([A-Za-z]):(/.*)?$', norm)

    if m and _IS_WSL:
        # Convert  D:/foo/bar  →  /mnt/d/foo/bar
        drive = m.group(1).lower()
        rest  = m.group(2) or ''
        return f'/mnt/{drive}{rest}'

    if _IS_WINDOWS:
        # On native Windows, let Path normalize separators consistently.
        # This handles both "D:/foo/bar" and "D:\\foo/bar" → "D:\\foo\\bar"
        return str(Path(norm))

    # POSIX (Linux / Mac) — just return with consistent forward slashes
    return norm


# Keep old name as alias for backward compat
_win_to_wsl = _normalize_path

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


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

@dataclass
class WatcherConfig:
    root_path: Path
    watch_interval: int = 2
    job_timeout: int = 1800  # 30 minutes in seconds
    pip_timeout: Optional[int] = None  # None = no timeout (heavy deps: tensorflow/birdnetlib)
    heartbeat_file: str = "system/status.json"
    scripts_dir: str = "system/scripts"
    installed_registry: str = "system/scripts/installed.json"
    venv_dir: str = "system/.venv"
    lock_file: str = "system/watcher.lock"
    req_hash_file: str = "system/.req_hash"
    github_repo_url: str = (
        "https://raw.githubusercontent.com/xHrid/cem-backend/master"
    )

    # Derived paths (computed post-init)
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


# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

def build_logger(name: str = "cem_watcher") -> logging.Logger:
    logger = logging.getLogger(name)
    if logger.handlers:
        return logger  # already configured — avoid duplicate handlers on reload

    logger.setLevel(logging.DEBUG)
    handler = logging.StreamHandler(sys.stdout)
    handler.setLevel(logging.DEBUG)
    fmt = logging.Formatter("[%(asctime)s] %(levelname)-8s %(message)s", datefmt="%H:%M:%S")
    handler.setFormatter(fmt)
    logger.addHandler(handler)
    return logger


logger = build_logger()


# ---------------------------------------------------------------------------
# Lock file — prevent concurrent watcher instances
# ---------------------------------------------------------------------------

class LockFile:
    """PID-based lock file.  Acquired on __enter__, released on __exit__."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self._acquired = False

    def _stale(self) -> bool:
        """Return True if the recorded PID is no longer running."""
        try:
            pid = int(self.path.read_text().strip())
            if os.name == "nt":
                import ctypes
                handle = ctypes.windll.kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
                if handle:
                    ctypes.windll.kernel32.CloseHandle(handle)
                    return False
                return True
            else:
                os.kill(pid, 0)  # signal 0 = existence check
            return False
        except (ValueError, FileNotFoundError):
            return True
        except OSError:
            return True

    def acquire(self) -> bool:
        if self.path.exists() and not self._stale():
            existing_pid = self.path.read_text().strip()
            logger.error(
                "Another watcher instance is already running (PID %s). "
                "Remove %s to force-start.",
                existing_pid,
                self.path,
            )
            return False
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(str(os.getpid()))
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


# ---------------------------------------------------------------------------
# Setup — virtual environment & script sync
# ---------------------------------------------------------------------------

class WatcherSetup:
    def __init__(self, cfg: WatcherConfig) -> None:
        self.cfg = cfg

    # ------------------------------------------------------------------
    # Heartbeat
    # ------------------------------------------------------------------

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

    # ------------------------------------------------------------------
    # Virtual environment
    # ------------------------------------------------------------------

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

            # Compare against stored hash — skip pip install if unchanged
            stored_hash: Optional[str] = None
            if cfg.req_hash_path.exists():
                stored_hash = cfg.req_hash_path.read_text().strip()

            if new_hash == stored_hash and req_path.exists():
                logger.info("Requirements unchanged — skipping pip install.")
                tmp_req.unlink()
                return

            # Hash changed (or first run) — replace file and reinstall
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

    # ------------------------------------------------------------------
    # Script sync
    # ------------------------------------------------------------------

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
                # Check Content-Length if server provided it
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

        # Validate Python files compile (catches truncation / corruption)
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
                return  # already up-to-date
            logger.info("    Updating: %s (from %s)", filename, folder)
        else:
            logger.info("    Downloading: %s (from %s)", filename, folder)

        # Atomic write: temp file + rename prevents partial-write corruption
        local_path.parent.mkdir(parents=True, exist_ok=True)
        tmp_path = local_path.with_suffix(local_path.suffix + ".tmp")
        tmp_path.write_bytes(remote_bytes)
        tmp_path.replace(local_path)


# ---------------------------------------------------------------------------
# Job processor
# ---------------------------------------------------------------------------

class JobProcessor:
    def __init__(self, cfg: WatcherConfig, setup: WatcherSetup) -> None:
        self.cfg = cfg
        self.setup = setup

    # ------------------------------------------------------------------
    # Aggregate path resolution
    # ------------------------------------------------------------------

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

        # Fallback: use outputs.master_csv if no aggregate_file declared
        master_name = script_def.get("outputs", {}).get("master_csv")
        if master_name:
            return str(db_dir / master_name)

        return None

    # ------------------------------------------------------------------
    # Job processing
    # ------------------------------------------------------------------

    def process(self, job_file: Path) -> None:
        cfg = self.cfg
        job_id = job_file.stem

        if not job_id or job_id.startswith('.'):
            job_id = f"unnamed_job_{int(time.time())}"

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
            if not script_path.exists():
                raise FileNotFoundError(f"Script not found: {script_name}")

            job_result_dir = results_dir / job_id
            job_result_dir.mkdir(parents=True, exist_ok=True)

            # Build command
            cmd = [cfg.venv_python, str(script_path)]

            # 1. Core paths
            cmd.extend(["--output-dir", str(job_result_dir)])
            cmd.extend(["--root-dir", str(cfg.root_path)])
            cmd.extend(["--project-dir", str(project_root)])

            # 2. Resolve input directories + reference files.
            #    - "datasets"    → spot/audio dirs (relative to root_path). The
            #                      script scans these recursively → INPUT_DIRECTORIES.
            #    - "input_files" → explicit reference WAV paths (absolute OS paths)
            #                      that live OUTSIDE the spot dirs → INPUT_FILE_LIST.
            #
            # The webapp runs on Windows and stores Windows paths (D:\...).
            # The watcher may run under WSL where those must become /mnt/d/...
            # for the filesystem to find them — _win_to_wsl handles that.
            # dataset_spots: aligned 1:1 with datasets — canonical UI spot name
            raw_dataset_spots = job_data.get("dataset_spots", [])
            resolved_dirs = []
            resolved_dir_spots = []
            for idx, d in enumerate(job_data.get("datasets", [])):
                spot_label = raw_dataset_spots[idx] if idx < len(raw_dataset_spots) else ""
                # Normalize first, then try as relative to root, then as absolute
                norm_d = _normalize_path(d)
                p = (cfg.root_path / norm_d).resolve()
                if not p.exists():
                    p = Path(norm_d).resolve()
                if p.exists():
                    resolved_dirs.append(str(p))
                    resolved_dir_spots.append(spot_label)
                else:
                    logger.warning("  dataset path not found: %s (tried: %s)", d, p)

            # Each input_files entry is {"path": ..., "spot": ...} (newer webapp)
            # or a bare path string (back-compat). The spot travels alongside the
            # file so the script can stamp it onto reference-file detections.
            resolved_files = []        # aligned with resolved_file_spots
            resolved_file_spots = []
            for entry in job_data.get("input_files", []):
                if isinstance(entry, dict):
                    raw, spot = entry.get("path"), entry.get("spot", "")
                else:
                    raw, spot = entry, ""
                if not raw:
                    continue
                p = Path(_normalize_path(raw)).resolve()
                if p.exists():
                    resolved_files.append(str(p))
                    resolved_file_spots.append(spot or "")
                else:
                    logger.warning("  reference file not found: %s (resolved: %s)", raw, p)

            def _dedup(seq):
                seen, out = set(), []
                for x in seq:
                    if x not in seen:
                        seen.add(x)
                        out.append(x)
                return out

            # Dedup dirs while keeping dataset_spots aligned.
            seen_d, unique_dirs, unique_dir_spots = set(), [], []
            for d, sp in zip(resolved_dirs, resolved_dir_spots):
                if d not in seen_d:
                    seen_d.add(d)
                    unique_dirs.append(d)
                    unique_dir_spots.append(sp)

            # Dedup reference files while keeping each one's spot aligned.
            seen_f, unique_files, unique_file_spots = set(), [], []
            for pth, sp in zip(resolved_files, resolved_file_spots):
                if pth not in seen_f:
                    seen_f.add(pth)
                    unique_files.append(pth)
                    unique_file_spots.append(sp)

            # Write large lists to temp files to avoid WinError 206
            # ("filename or extension is too long") — Windows has a ~32k char
            # command-line limit which 85k file paths easily exceed.
            #
            # Strategy: always write file lists to disk. Pass --*-file args
            # pointing to those files. For small lists (< 50 items), also pass
            # inline args for backward compat with older scripts.
            job_tmp_dir = job_result_dir / "_tmp"
            job_tmp_dir.mkdir(parents=True, exist_ok=True)

            _INLINE_THRESHOLD = 50  # safe under any OS command-line limit

            if unique_dirs:
                dirs_file = job_tmp_dir / "datasets.txt"
                dirs_file.write_text("\n".join(unique_dirs), encoding="utf-8")
                cmd.extend(["--datasets-file", str(dirs_file)])
                if len(unique_dirs) <= _INLINE_THRESHOLD:
                    cmd.extend(["--datasets"] + unique_dirs)
                if any(s for s in unique_dir_spots):
                    spots_file = job_tmp_dir / "dataset_spots.txt"
                    spots_file.write_text(
                        "\n".join(s or "_" for s in unique_dir_spots),
                        encoding="utf-8",
                    )
                    cmd.extend(["--dataset-spots-file", str(spots_file)])
                    if len(unique_dir_spots) <= _INLINE_THRESHOLD:
                        cmd.extend(["--dataset-spots"] + [s or "_" for s in unique_dir_spots])

            if unique_files:
                files_file = job_tmp_dir / "input_files.txt"
                files_file.write_text("\n".join(unique_files), encoding="utf-8")
                cmd.extend(["--input-file-list-file", str(files_file)])
                if len(unique_files) <= _INLINE_THRESHOLD:
                    cmd.extend(["--input-file-list"] + unique_files)
                file_spots_file = job_tmp_dir / "input_file_spots.txt"
                file_spots_file.write_text(
                    "\n".join(s or "_" for s in unique_file_spots),
                    encoding="utf-8",
                )
                cmd.extend(["--input-file-spots-file", str(file_spots_file)])
                if len(unique_file_spots) <= _INLINE_THRESHOLD:
                    cmd.extend(["--input-file-spots"] + [s or "_" for s in unique_file_spots])

            # 3. Unpack UI parameters (spots, start_date, end_date, snr_db, ...)
            for key, val in params.items():
                cmd.extend([f"--{key.replace('_', '-')}", str(val)])

            # 4. Pass denoise clips + eBird checklist if synced into scripts dir
            noise_file = (cfg.scripts_path / "static_noise.wav").resolve()
            if noise_file.exists():
                cmd.extend(["--noise-path", str(noise_file)])
            rain_file = (cfg.scripts_path / "rain_noise.wav").resolve()
            if rain_file.exists():
                cmd.extend(["--rain-path", str(rain_file)])
            ebird_file = (cfg.scripts_path / "ebird_checklist.txt").resolve()
            if ebird_file.exists():
                cmd.extend(["--ebird-file", str(ebird_file)])

            # 5. Pass aggregate + processed-files paths (scripts own read/write)
            aggregate_path = self._resolve_aggregate_path(script_name, db_dir)
            if aggregate_path:
                cmd.extend(["--aggregate-file", aggregate_path])
                logger.info("  Aggregate: %s", aggregate_path)
            # Strip .py extension so we get "processed_birdnet_predictions.txt"
            # instead of "processed_birdnet_predictions.py.txt"
            script_stem = Path(script_name).stem
            processed_path = str(db_dir / f"processed_{script_stem}.txt")
            cmd.extend(["--processed-file", processed_path])

            # ── Meaningful job summary instead of dumping the raw command ──
            logger.info("  ┌─ Job Summary ─────────────────────────────")
            logger.info("  │ Script:          %s", script_name)
            logger.info("  │ Dataset dirs:    %d", len(unique_dirs))
            logger.info("  │ Reference files: %d", len(unique_files))
            if unique_dir_spots:
                spot_names = sorted(set(s for s in unique_dir_spots if s and s != "_"))
                logger.info("  │ Spots:           %s", ", ".join(spot_names) if spot_names else "(none)")
            param_strs = [f"{k}={v}" for k, v in params.items()]
            if param_strs:
                logger.info("  │ Params:          %s", ", ".join(param_strs))
            logger.info("  └─────────────────────────────────────────")
            logger.debug("  Full CMD: %s", " ".join(str(c) for c in cmd))
            self.setup.update_heartbeat("processing_job")

            total_files = len(unique_files) + sum(
                _count_audio_files(d) for d in unique_dirs
            )

            start_time = time.time()
            stdout_log = []
            stderr_log = []

            proc = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                bufsize=1,       # line-buffered
            )

            # ── Stream stdout with live progress bar ──────────────────
            files_done = 0
            last_pct   = -1
            _PROG_RE   = _re.compile(
                r'(?:processing|analyzing|analysing|processed|done)[:\s]*(\d+)',
                _re.IGNORECASE,
            )
            _FILE_DONE_RE = _re.compile(
                r'(?:saved|wrote|finished|complete|done|processed)\b',
                _re.IGNORECASE,
            )

            try:
                for line in proc.stdout:
                    stdout_log.append(line)
                    stripped = line.rstrip()

                    # Try to extract explicit count from script output
                    m = _PROG_RE.search(stripped)
                    if m:
                        files_done = int(m.group(1))
                    elif _FILE_DONE_RE.search(stripped):
                        files_done += 1

                    # Render progress bar
                    if total_files > 0:
                        pct = min(int(files_done * 100 / total_files), 100)
                    else:
                        pct = 0

                    if pct != last_pct:
                        bar_w   = 30
                        filled  = int(bar_w * pct / 100)
                        bar     = '█' * filled + '░' * (bar_w - filled)
                        elapsed = time.time() - start_time
                        eta_str = ""
                        if pct > 0 and pct < 100:
                            eta_sec = elapsed / pct * (100 - pct)
                            eta_m, eta_s = divmod(int(eta_sec), 60)
                            eta_str = f" ETA {eta_m}m{eta_s:02d}s"
                        # \r overwrite on terminals, logged as INFO for file loggers
                        print(
                            f"\r  ⏳ [{bar}] {pct:3d}% "
                            f"({files_done}/{total_files}) "
                            f"{int(elapsed)}s elapsed{eta_str}   ",
                            end="", flush=True,
                        )
                        last_pct = pct

                proc.wait(timeout=cfg.job_timeout)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
                raise

            # Read any remaining stderr
            stderr_text = proc.stderr.read()
            if stderr_text:
                stderr_log.append(stderr_text)

            # Final newline after progress bar
            print()

            execution_duration = time.time() - start_time
            stdout_text = "".join(stdout_log)
            stderr_combined = "".join(stderr_log)

            # Clean up temp list files
            if job_tmp_dir.exists():
                shutil.rmtree(job_tmp_dir, ignore_errors=True)

            if proc.returncode == 0:
                elapsed_m, elapsed_s = divmod(int(execution_duration), 60)
                logger.info(
                    "  ✅ Done! %d files in %dm%02ds (%.1f files/sec)",
                    files_done or total_files,
                    elapsed_m, elapsed_s,
                    (files_done or total_files) / max(execution_duration, 0.1),
                )
                (job_result_dir / "stdout.log").write_text(stdout_text)

                # Write execution stats
                stats_data = {
                    "execution_time_seconds": execution_duration,
                    "execution_time_formatted": f"{elapsed_m}m {elapsed_s}s",
                    "files_processed": files_done or total_files,
                    "files_per_second": round(
                        (files_done or total_files) / max(execution_duration, 0.1), 2
                    ),
                }
                with open(job_result_dir / "run_stats.json", "w") as fh:
                    json.dump(stats_data, fh)

                shutil.move(
                    str(processing_path),
                    str(completed_dir / job_file.name),
                )
            else:
                logger.error(
                    "  ❌ Failed after %.2fs (code %d)",
                    execution_duration,
                    proc.returncode,
                )
                error_text = stderr_combined
                if stdout_text:
                    error_text += (
                        "\n--- stdout ---\n" + stdout_text
                        if error_text
                        else stdout_text
                    )
                (job_result_dir / "error.log").write_text(error_text)
                raise RuntimeError("Script execution failed. Check error.log")

        except subprocess.TimeoutExpired:
            logger.error("  Job %s timed out after %ds", job_id, cfg.job_timeout)
            shutil.move(str(processing_path), str(failed_dir / job_file.name))
        except Exception as exc:
            logger.error("  Job failed: %s", exc)
            if processing_path.exists():
                shutil.move(str(processing_path), str(failed_dir / job_file.name))


# ---------------------------------------------------------------------------
# Main watcher loop
# ---------------------------------------------------------------------------

class Watcher:
    def __init__(self, cfg: WatcherConfig) -> None:
        self.cfg = cfg
        self.setup = WatcherSetup(cfg)
        self.processor = JobProcessor(cfg, self.setup)
        self._running = False

    # ------------------------------------------------------------------
    # Signal / graceful shutdown
    # ------------------------------------------------------------------

    def _handle_signal(self, signum, _frame) -> None:
        sig_name = signal.Signals(signum).name if hasattr(signal, "Signals") else str(signum)
        logger.info("Received %s — shutting down gracefully...", sig_name)
        self._running = False

    def _register_signals(self) -> None:
        signal.signal(signal.SIGINT, self._handle_signal)
        if hasattr(signal, "SIGTERM"):
            signal.signal(signal.SIGTERM, self._handle_signal)
        # Survive the controlling terminal closing: SIGHUP's default action is
        # to kill the process (and its whole foreground group, including a
        # running analysis child). Ignore it so closing the terminal no longer
        # terminates the watcher. Still run detached (nohup/setsid/systemd) and
        # redirect output, or log writes to the dead TTY can fail.
        if hasattr(signal, "SIGHUP"):
            signal.signal(signal.SIGHUP, signal.SIG_IGN)

    # ------------------------------------------------------------------
    # Entry point
    # ------------------------------------------------------------------

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

                self._running = True
                while self._running:
                    self.setup.update_heartbeat("online")
                    job_files = sorted(
                        cfg.root_path.glob("*/jobs/queue/*.json"),
                        key=lambda f: f.stat().st_mtime,
                    )
                    if job_files:
                        self.processor.process(job_files[0])
                    time.sleep(cfg.watch_interval)

        except RuntimeError as exc:
            # Lock acquisition failure
            logger.error("%s", exc)
            sys.exit(1)
        finally:
            logger.info("Watcher stopped. Cleaning up...")
            self.setup.remove_heartbeat()


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

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
