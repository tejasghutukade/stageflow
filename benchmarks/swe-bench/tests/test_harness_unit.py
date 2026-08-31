from __future__ import annotations

import json
from pathlib import Path

import pytest

from harness.config import HarnessConfig, find_stageflow_root
from harness.dataset import apply_slice, docker_image_name
from harness.predictions import (
    append_prediction,
    load_completed_instance_ids,
    prediction_row,
    rewrite_preds_json,
)
from harness.host_runner import run_stageflow_on_host
from harness.taskgen import render_task
from harness.dataset import SweBenchInstance


def test_docker_image_name_transform() -> None:
    assert docker_image_name("sympy__sympy-20590") == (
        "docker.io/swebench/sweb.eval.x86_64.sympy_1776_sympy-20590:latest"
    )


def test_apply_slice() -> None:
    items = [
        SweBenchInstance("a", "r/a", "sha", "problem"),
        SweBenchInstance("b", "r/b", "sha", "problem"),
        SweBenchInstance("c", "r/c", "sha", "problem"),
    ]
    sliced = apply_slice(items, "1:3")
    assert [item.instance_id for item in sliced] == ["b", "c"]


def test_task_render(tmp_path: Path) -> None:
    root = find_stageflow_root()
    config = HarnessConfig(
        stageflow_root=root,
        output_dir=tmp_path,
        pipeline=root / "benchmarks/swe-bench/pipelines/stub.pipeline.yaml",
    )
    instance = SweBenchInstance(
        instance_id="django__django-1000",
        repo="django/django",
        base_commit="abc123",
        problem_statement="Fix the bug in admin.",
    )
    out = tmp_path / "task.yaml"
    render_task(instance, config, out)
    text = out.read_text(encoding="utf-8")
    assert "django__django-1000" in text
    assert "Fix the bug in admin." in text


def test_predictions_incremental(tmp_path: Path) -> None:
    jsonl = tmp_path / "all_preds.jsonl"
    append_prediction(
        jsonl,
        prediction_row(
            instance_id="foo",
            model_patch="diff",
            model_name_or_path="stageflow/test",
            outcome="succeeded",
        ),
    )
    assert load_completed_instance_ids(jsonl) == {"foo"}
    rewrite_preds_json(jsonl, tmp_path / "preds.json")
    preds = json.loads((tmp_path / "preds.json").read_text(encoding="utf-8"))
    assert preds["foo"]["model_patch"] == "diff"


def test_host_runner_uses_stageflow_store_root_env(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = find_stageflow_root()
    instance_dir = tmp_path / "instance"
    store_path = instance_dir / ".stageflow"
    repo_stageflow = root / ".stageflow"
    repo_stageflow.mkdir(exist_ok=True)
    marker = repo_stageflow / "preserve-me"
    marker.write_text("keep", encoding="utf-8")

    captured: dict[str, str] = {}

    def fake_run(cmd, **kwargs):
        captured["store_root"] = kwargs.get("env", {}).get("STAGEFLOW_STORE_ROOT", "")
        class Result:
            returncode = 1
            stdout = '{"ok": false, "outcome": "failed"}'
            stderr = ""

        return Result()

    monkeypatch.setattr("harness.host_runner.subprocess.run", fake_run)
    monkeypatch.setattr(
        "harness.host_runner.ensure_stageflow_built",
        lambda _root: root / "dist/cli.js",
    )

    config = HarnessConfig(
        stageflow_root=root,
        output_dir=tmp_path,
        pipeline=root / "benchmarks/swe-bench/pipelines/stub.pipeline.yaml",
    )
    run_stageflow_on_host(
        config,
        task_path=tmp_path / "task.yaml",
        checkout_path=tmp_path / "testbed",
        instance_dir=instance_dir,
        base_commit="abc",
        store_path=store_path,
    )

    assert captured["store_root"] == str(store_path.resolve())
    assert marker.read_text(encoding="utf-8") == "keep"
