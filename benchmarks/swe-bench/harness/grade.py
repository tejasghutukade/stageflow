from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

from .config import HarnessConfig


def grade_local(config: HarnessConfig, *, run_id: str, workers: int = 4) -> int:
    preds = config.preds_jsonl_path()
    if not preds.is_file():
        raise FileNotFoundError(f"Missing predictions file: {preds}")

    subset_flag = "verified" if config.subset.lower() == "verified" else "lite"
    cmd = [
        "swebench",
        "eval",
        subset_flag,
        "-p",
        str(preds),
        "--run-id",
        run_id,
        "-j",
        str(workers),
    ]
    try:
        completed = subprocess.run(cmd, check=False, capture_output=True, text=True)
    except FileNotFoundError as err:
        raise RuntimeError(
            "Install eval extras: pip install -e 'benchmarks/swe-bench[eval]'",
        ) from err

    grade_log = config.output_dir / "grade.log"
    grade_log.write_text(
        (completed.stdout or "") + (completed.stderr or ""),
        encoding="utf-8",
    )

    summary_path = config.output_dir / "grade-summary.json"
    summary_path.write_text(
        json.dumps(
            {
                "command": cmd,
                "returncode": completed.returncode,
                "stdout": completed.stdout,
                "stderr": completed.stderr,
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    return completed.returncode


def grade_cloud(config: HarnessConfig, *, run_id: str) -> int:
    preds = config.preds_json_path()
    if not preds.is_file():
        raise FileNotFoundError(f"Missing predictions file: {preds}")

    subset = "swe-bench_verified" if config.subset.lower() == "verified" else "swe-bench_lite"
    cmd = [
        "sb-cli",
        "submit",
        subset,
        config.split,
        "--predictions_path",
        str(preds),
        "--run_id",
        run_id,
    ]
    try:
        completed = subprocess.run(cmd, check=False, capture_output=True, text=True)
    except FileNotFoundError as err:
        raise RuntimeError("Install sb-cli: pip install sb-cli") from err

    grade_log = config.output_dir / "sb-cli.log"
    grade_log.write_text(
        (completed.stdout or "") + (completed.stderr or ""),
        encoding="utf-8",
    )
    return completed.returncode


def copy_eval_logs(source: Path, dest: Path) -> None:
    if not source.is_dir():
        return
    dest.mkdir(parents=True, exist_ok=True)
    for child in source.iterdir():
        target = dest / child.name
        if child.is_dir():
            if target.exists():
                shutil.rmtree(target)
            shutil.copytree(child, target)
        else:
            shutil.copy2(child, target)
