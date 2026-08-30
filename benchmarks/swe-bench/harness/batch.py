from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from .config import HarnessConfig, ensure_stageflow_built
from .dataset import SweBenchInstance, load_instances
from .instance_runner import run_instance
from .predictions import load_completed_instance_ids, rewrite_preds_json


def run_batch(config: HarnessConfig) -> dict:
    instances = load_instances(
        config.subset,
        config.split,
        instance_ids=config.instance_ids,
        slice_spec=config.slice_spec,
    )

    completed = load_completed_instance_ids(config.preds_jsonl_path()) if config.resume else set()
    pending = [item for item in instances if item.instance_id not in completed]

    config.output_dir.mkdir(parents=True, exist_ok=True)
    summary_path = config.output_dir / "summary.json"
    results: list[dict] = []

    if not pending:
        summary = {
            "total": len(instances),
            "ran": 0,
            "skipped": len(completed),
            "results": [],
        }
        summary_path.write_text(json.dumps(summary, indent=2), encoding="utf-8")
        return summary

    if not config.dry_run:
        ensure_stageflow_built(config.stageflow_root)
        from .docker import ensure_docker_available

        ensure_docker_available()

    workers = max(1, config.workers)

    def _worker(instance: SweBenchInstance, worker_id: int) -> dict:
        result = run_instance(instance, config, worker_id=worker_id)
        return {
            "instance_id": result.instance_id,
            "outcome": result.outcome,
            "run_id": result.run_id,
            "duration_ms": result.duration_ms,
            "patch_bytes": len(result.model_patch.encode("utf-8")),
            "error": result.error,
        }

    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {
            pool.submit(_worker, instance, index % workers): instance.instance_id
            for index, instance in enumerate(pending)
        }
        for future in as_completed(futures):
            results.append(future.result())

    rewrite_preds_json(config.preds_jsonl_path(), config.preds_json_path())

    summary = {
        "total": len(instances),
        "ran": len(pending),
        "skipped": len(completed),
        "results": sorted(results, key=lambda row: row["instance_id"]),
    }
    summary_path.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    return summary
