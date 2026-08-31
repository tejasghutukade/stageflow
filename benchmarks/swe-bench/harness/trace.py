from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .config import HarnessConfig


def read_json_if_exists(path: Path) -> dict[str, Any] | None:
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None


def read_jsonl_lines(path: Path) -> list[Any]:
    if not path.is_file():
        return []
    lines: list[Any] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            lines.append(json.loads(line))
        except json.JSONDecodeError:
            lines.append({"raw": line})
    return lines


def resolve_run_workspace(
    config: HarnessConfig,
    worker_store_host: Path,
    run_dir: str,
) -> Path | None:
    run_id = Path(run_dir).name
    candidate = worker_store_host / "runs" / run_id
    if candidate.is_dir():
        return candidate
    alt = config.stageflow_root / run_dir
    if alt.is_dir():
        return alt
    alt2 = config.stageflow_root / ".stageflow" / "runs" / run_id
    if alt2.is_dir():
        return alt2
    return None


def collect_stage_traces(run_workspace: Path) -> list[dict[str, Any]]:
    stages_root = run_workspace / "stages"
    if not stages_root.is_dir():
        return []

    traces: list[dict[str, Any]] = []
    for stage_dir in sorted(stages_root.iterdir()):
        if not stage_dir.is_dir():
            continue
        stage_id = stage_dir.name
        attempts_dir = stage_dir / "attempts"
        if not attempts_dir.is_dir():
            continue
        for attempt_dir in sorted(attempts_dir.iterdir()):
            if not attempt_dir.is_dir():
                continue
            attempt = attempt_dir.name
            session_path = attempt_dir / "pi-session.jsonl"
            envelope_path = attempt_dir / "envelope.json"
            stage_trace: dict[str, Any] = {
                "stage_id": stage_id,
                "attempt": int(attempt) if attempt.isdigit() else attempt,
                "pi_session_path": str(session_path.relative_to(run_workspace)),
            }
            if envelope_path.is_file():
                envelope = read_json_if_exists(envelope_path)
                if envelope is not None:
                    stage_trace["envelope"] = envelope
            if session_path.is_file():
                stage_trace["pi_session"] = read_jsonl_lines(session_path)
            traces.append(stage_trace)
    return traces


def build_trace_document(
    *,
    instance_id: str,
    config: HarnessConfig,
    sf_run: dict[str, Any] | None,
    run_export: dict[str, Any] | None,
    worker_store_host: Path,
) -> dict[str, Any]:
    run_id = sf_run.get("runId") if sf_run else None
    run_dir = sf_run.get("runDir") if sf_run else None
    stages: list[dict[str, Any]] = []
    if run_dir and isinstance(run_dir, str):
        workspace = resolve_run_workspace(config, worker_store_host, run_dir)
        if workspace is not None:
            stages = collect_stage_traces(workspace)
    if run_export and run_export.get("stages"):
        for exported in run_export["stages"]:
            stage_id = exported.get("stage_id")
            if stage_id and not any(s.get("stage_id") == stage_id for s in stages):
                stages.append(
                    {
                        "stage_id": stage_id,
                        "attempt": 1,
                        "envelope": exported.get("envelope"),
                        "events": exported.get("events"),
                    },
                )

    return {
        "instance_id": instance_id,
        "run_id": run_id,
        "run_dir": run_dir,
        "pipeline": str(config.pipeline),
        "model_name_or_path": config.model_name_or_path,
        "outcome": sf_run.get("outcome") if sf_run else None,
        "stages": stages,
    }


def write_trace(
    config: HarnessConfig,
    instance_id: str,
    document: dict[str, Any],
) -> Path:
    config.trajs_dir().mkdir(parents=True, exist_ok=True)
    out_path = config.trajs_dir() / f"{instance_id}.json"
    out_path.write_text(json.dumps(document, indent=2), encoding="utf-8")
    return out_path
