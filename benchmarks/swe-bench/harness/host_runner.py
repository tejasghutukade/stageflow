from __future__ import annotations

import json
import os
import platform
import subprocess
from pathlib import Path

from .config import HarnessConfig, ensure_stageflow_built
from .trace import read_json_if_exists


def should_use_host_stageflow(config: HarnessConfig) -> bool:
    mode = config.execution_mode
    if mode == "host":
        return True
    if mode == "container":
        return False
    return platform.system() == "Darwin"


def _parse_sf_run_output(text: str) -> dict | None:
    stripped = text.strip()
    if not stripped:
        return None
    try:
        return json.loads(stripped)
    except json.JSONDecodeError:
        start = stripped.find("{")
        end = stripped.rfind("}")
        if start >= 0 and end > start:
            try:
                return json.loads(stripped[start : end + 1])
            except json.JSONDecodeError:
                return None
    return None


def run_stageflow_on_host(
    config: HarnessConfig,
    *,
    task_path: Path,
    checkout_path: Path,
    instance_dir: Path,
    base_commit: str,
    store_path: Path,
) -> tuple[int, dict | None]:
    cli = ensure_stageflow_built(config.stageflow_root)
    sf_run_host = instance_dir / "sf-run.json"
    sf_exit_host = instance_dir / "sf-run.exit"
    log_path = instance_dir / "container.log"

    store_path.mkdir(parents=True, exist_ok=True)
    env = os.environ.copy()
    env["STAGEFLOW_STORE_ROOT"] = str(store_path.resolve())

    run_cmd = [
        "node",
        str(cli),
        "run",
        "--task",
        str(task_path.resolve()),
        "--pipeline",
        str(config.pipeline.resolve()),
        "--checkout",
        str(checkout_path.resolve()),
        "--skip-gates",
        "--json",
        "--include",
        "stages",
        "--git-sha",
        base_commit,
    ]

    proc = subprocess.run(
        run_cmd,
        cwd=config.stageflow_root,
        capture_output=True,
        text=True,
        env=env,
    )
    combined = (proc.stdout or "") + (proc.stderr or "")
    log_path.write_text(combined, encoding="utf-8")
    sf_exit_host.write_text(str(proc.returncode), encoding="utf-8")
    if combined.strip():
        sf_run_host.write_text(combined, encoding="utf-8")

    sf_run = _parse_sf_run_output(proc.stdout or "") or _parse_sf_run_output(combined)

    if sf_run is not None:
        sf_run_host.write_text(json.dumps(sf_run, indent=2), encoding="utf-8")

    export_cmd = [
        "node",
        str(cli),
        "export-run",
        "--from",
        str(sf_run_host.resolve()),
        "--out",
        str((instance_dir / "run-export.json").resolve()),
    ]
    subprocess.run(
        export_cmd,
        cwd=config.stageflow_root,
        capture_output=True,
        text=True,
        env=env,
    )

    if sf_run is None:
        sf_run = read_json_if_exists(sf_run_host)
        if sf_run is None and sf_run_host.is_file():
            sf_run = _parse_sf_run_output(sf_run_host.read_text(encoding="utf-8"))

    exit_code = proc.returncode
    try:
        exit_code = int(sf_exit_host.read_text(encoding="utf-8").strip())
    except (OSError, ValueError):
        pass

    return exit_code, sf_run
