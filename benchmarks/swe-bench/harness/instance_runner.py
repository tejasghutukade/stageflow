from __future__ import annotations

import json
import time
from dataclasses import dataclass
from pathlib import Path

from docker.models.containers import Container

from .bootstrap import bootstrap_container
from .config import HarnessConfig
from .dataset import SweBenchInstance, docker_image_name
from .docker import DockerManager, shell_join
from .patch import extract_patch
from .predictions import append_prediction, prediction_row
from .taskgen import render_task, task_container_path
from .trace import build_trace_document, read_json_if_exists, write_trace


@dataclass
class InstanceResult:
    instance_id: str
    outcome: str
    run_id: str | None
    model_patch: str
    error: str | None = None
    duration_ms: int = 0


def run_instance(
    instance: SweBenchInstance,
    config: HarnessConfig,
    *,
    worker_id: int = 0,
) -> InstanceResult:
    started = time.time()
    instance_dir = config.instances_dir() / instance.instance_id
    instance_dir.mkdir(parents=True, exist_ok=True)
    worker_store = config.worker_store_root(worker_id)
    worker_store.mkdir(parents=True, exist_ok=True)

    task_path = instance_dir / "task.yaml"
    render_task(instance, config, task_path)

    if config.dry_run:
        return InstanceResult(
            instance_id=instance.instance_id,
            outcome="dry_run",
            run_id=None,
            model_patch="",
            duration_ms=int((time.time() - started) * 1000),
        )

    docker = DockerManager(config)
    image = instance.image or docker_image_name(instance.instance_id)
    container: Container | None = None
    log_path = instance_dir / "container.log"

    try:
        container = docker.start_container(
            instance.instance_id,
            image,
            str(instance_dir.resolve()),
            str(worker_store.resolve()),
        )
        bootstrap_container(container, docker, config, worker_store)

        pipeline_path = config.pipeline_container_path()
        task_in_container = task_container_path(config)
        sf_run_host = instance_dir / "sf-run.json"

        sf_cmd = shell_join(
            [
                "node",
                f"{config.container_stageflow_mount}/dist/cli.js",
                "run",
                "--task",
                task_in_container,
                "--pipeline",
                pipeline_path,
                "--checkout",
                config.container_checkout,
                "--skip-gates",
                "--json",
                "--include",
                "stages",
                "--git-sha",
                instance.base_commit,
            ],
        )

        sf_result = docker.exec(
            container,
            f"cd {config.container_stageflow_mount} && {sf_cmd} > {config.container_output_mount}/sf-run.json 2>&1; echo $? > {config.container_output_mount}/sf-run.exit",
            workdir=config.container_stageflow_mount,
        )

        log_path.write_text(
            (sf_result.stdout or "") + (sf_result.stderr or ""),
            encoding="utf-8",
        )

        exit_code = _read_exit_code(instance_dir / "sf-run.exit")
        sf_run = read_json_if_exists(sf_run_host)

        export_cmd = shell_join(
            [
                "node",
                f"{config.container_stageflow_mount}/dist/cli.js",
                "export-run",
                "--from",
                f"{config.container_output_mount}/sf-run.json",
                "--out",
                f"{config.container_output_mount}/run-export.json",
            ],
        )
        docker.exec(
            container,
            f"cd {config.container_stageflow_mount} && {export_cmd} || true",
            workdir=config.container_stageflow_mount,
        )

        model_patch = extract_patch(container, docker, config)
        run_export = read_json_if_exists(instance_dir / "run-export.json")

        trace_doc = build_trace_document(
            instance_id=instance.instance_id,
            config=config,
            sf_run=sf_run,
            run_export=run_export,
            worker_store_host=worker_store,
        )
        write_trace(config, instance.instance_id, trace_doc)

        outcome = _resolve_outcome(sf_run, exit_code)
        run_id = sf_run.get("runId") if sf_run else None

        append_prediction(
            config.preds_jsonl_path(),
            prediction_row(
                instance_id=instance.instance_id,
                model_patch=model_patch,
                model_name_or_path=config.model_name_or_path,
                outcome=outcome,
                run_id=run_id if isinstance(run_id, str) else None,
            ),
        )

        return InstanceResult(
            instance_id=instance.instance_id,
            outcome=outcome,
            run_id=run_id if isinstance(run_id, str) else None,
            model_patch=model_patch,
            duration_ms=int((time.time() - started) * 1000),
        )
    except Exception as err:
        append_prediction(
            config.preds_jsonl_path(),
            prediction_row(
                instance_id=instance.instance_id,
                model_patch="",
                model_name_or_path=config.model_name_or_path,
                outcome="error",
                error=str(err),
            ),
        )
        return InstanceResult(
            instance_id=instance.instance_id,
            outcome="error",
            run_id=None,
            model_patch="",
            error=str(err),
            duration_ms=int((time.time() - started) * 1000),
        )
    finally:
        if container is not None:
            docker.stop_and_remove(container)


def _read_exit_code(path: Path) -> int:
    if not path.is_file():
        return 1
    try:
        return int(path.read_text(encoding="utf-8").strip())
    except ValueError:
        return 1


def _resolve_outcome(sf_run: dict | None, exit_code: int) -> str:
    if sf_run and isinstance(sf_run.get("outcome"), str):
        return sf_run["outcome"]
    if exit_code == 0:
        return "succeeded"
    if exit_code == 2:
        return "waiting"
    return "failed"
