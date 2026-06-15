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
import shutil
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Optional
import re as _re


# ---------------------------------------------------------------------------
# Path utilities
# ---------------------------------------------------------------------------

def _win_to_wsl(path_str: str) -> str:
    """Convert a Windows-style path to a WSL /mnt/ path if running under WSL.

    E.g.  "D:/CEM-Cloud/data"  → "/mnt/d/CEM-Cloud/data"
          "D:\\CEM-Cloud\\data" → "/mnt/d/CEM-Cloud/data"

    If the path is already POSIX or we're not on WSL, returns it unchanged.
    """
    # Normalise backslashes first
    norm = path_str.replace('\\', '/')

    # Match a Windows drive letter at the start: D:/ or D:
    m = _re.match(r'^([A-Za-z]):(/.*)?$', norm)
    if not m:
        return path_str  # already a POSIX path or relative

    # Only convert if /mnt exists (i.e. we're likely in WSL)
    if not Path('/mnt').is_dir():
        return path_str  # native Windows — keep as-is

    drive = m.group(1).lower()
    rest  = m.group(2) or ''
    return f'/mnt/{drive}{rest}'


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
        "https://raw.githubusercontent.com/xHrid/cem-backend/main"
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
            resolved_dirs = []
            for d in job_data.get("datasets", []):
                p = (cfg.root_path / d).resolve()
                if p.exists():
                    resolved_dirs.append(str(p))
                else:
                    p2 = Path(_win_to_wsl(d)).resolve()  # may already be absolute
                    if p2.exists():
                        resolved_dirs.append(str(p2))
                    else:
                        logger.warning("  dataset path not found: %s", d)

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
                p = Path(_win_to_wsl(raw)).resolve()
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

            unique_dirs = _dedup(resolved_dirs)
            if unique_dirs:
                cmd.extend(["--datasets"] + unique_dirs)

            # Dedup reference files while keeping each one's spot aligned.
            seen_f, unique_files, unique_file_spots = set(), [], []
            for pth, sp in zip(resolved_files, resolved_file_spots):
                if pth not in seen_f:
                    seen_f.add(pth)
                    unique_files.append(pth)
                    unique_file_spots.append(sp)
            if unique_files:
                cmd.extend(["--input-file-list"] + unique_files)
                cmd.extend(["--input-file-spots"] + [s or "_" for s in unique_file_spots])
                logger.info("  Reference files: %d", len(unique_files))

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
            processed_path = str(db_dir / f"processed_{script_name}.txt")
            cmd.extend(["--processed-file", processed_path])

            logger.info("  Running %s in isolated venv...", script_name)
            logger.info("  CMD: %s", " ".join(str(c) for c in cmd))
            self.setup.update_heartbeat("processing_job")

            start_time = time.time()
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=cfg.job_timeout,
            )
            execution_duration = time.time() - start_time

            if result.returncode == 0:
                logger.info("  Success! (%.2fs)", execution_duration)
                (job_result_dir / "stdout.log").write_text(result.stdout)

                # Write execution stats
                stats_data = {
                    "execution_time_seconds": execution_duration,
                    "execution_time_formatted": (
                        f"{int(execution_duration // 60)}m "
                        f"{int(execution_duration % 60)}s"
                    ),
                }
                with open(job_result_dir / "run_stats.json", "w") as fh:
                    json.dump(stats_data, fh)

                # No UI cache to write: the script maintains its own
                # processed_<script>.txt (single source of truth) and the
                # frontend reads that directly.

                shutil.move(
                    str(processing_path),
                    str(completed_dir / job_file.name),
                )
            else:
                logger.error(
                    "  Failed after %.2fs (code %d)",
                    execution_duration,
                    result.returncode,
                )
                # Combine stderr + stdout so error messages aren't lost
                # (scripts often print errors to stdout before sys.exit(1))
                error_text = result.stderr or ""
                if result.stdout:
                    error_text += (
                        "\n--- stdout ---\n" + result.stdout
                        if error_text
                        else result.stdout
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
