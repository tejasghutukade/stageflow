from __future__ import annotations

import json
import threading
from pathlib import Path
from typing import Any

_lock = threading.Lock()


def load_completed_instance_ids(jsonl_path: Path) -> set[str]:
    if not jsonl_path.is_file():
        return set()
    completed: set[str] = set()
    for line in jsonl_path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        instance_id = row.get("instance_id")
        if isinstance(instance_id, str):
            completed.add(instance_id)
    return completed


def append_prediction(jsonl_path: Path, row: dict[str, Any]) -> None:
    jsonl_path.parent.mkdir(parents=True, exist_ok=True)
    line = json.dumps(row, ensure_ascii=False)
    with _lock:
        with jsonl_path.open("a", encoding="utf-8") as handle:
            handle.write(line + "\n")
        rewrite_preds_json(jsonl_path, jsonl_path.with_name("preds.json"))


def rewrite_preds_json(jsonl_path: Path, json_out: Path) -> None:
    preds: dict[str, dict[str, str]] = {}
    if jsonl_path.is_file():
        for line in jsonl_path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            row = json.loads(line)
            instance_id = row["instance_id"]
            preds[instance_id] = {
                "model_patch": row.get("model_patch", ""),
                "model_name_or_path": row.get("model_name_or_path", ""),
            }
    json_out.write_text(json.dumps(preds, indent=2), encoding="utf-8")


def prediction_row(
    *,
    instance_id: str,
    model_patch: str,
    model_name_or_path: str,
    outcome: str,
    run_id: str | None = None,
    error: str | None = None,
) -> dict[str, Any]:
    row: dict[str, Any] = {
        "instance_id": instance_id,
        "model_patch": model_patch,
        "model_name_or_path": model_name_or_path,
        "outcome": outcome,
    }
    if run_id:
        row["run_id"] = run_id
    if error:
        row["error"] = error
    return row
