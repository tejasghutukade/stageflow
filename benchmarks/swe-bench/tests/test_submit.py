from __future__ import annotations

from pathlib import Path

from harness.config import HarnessConfig, find_stageflow_root
from harness.submit import package_submission


def test_package_submission(tmp_path: Path) -> None:
    root = find_stageflow_root()
    output = tmp_path / "run"
    output.mkdir()
    (output / "all_preds.jsonl").write_text(
        '{"instance_id":"foo","model_patch":"","model_name_or_path":"x","outcome":"succeeded"}\n',
        encoding="utf-8",
    )
    (output / "preds.json").write_text("{}", encoding="utf-8")
    trajs = output / "trajs"
    trajs.mkdir()
    (trajs / "foo.json").write_text("{}", encoding="utf-8")

    config = HarnessConfig(
        stageflow_root=root,
        output_dir=output,
        pipeline=root / "benchmarks/swe-bench/pipelines/stub.pipeline.yaml",
        subset="lite",
    )
    target = package_submission(config, submission_name="test_submission")
    assert target.is_dir()
    assert (target / "all_preds.jsonl").is_file()
    assert (target / "trajs" / "foo.json").is_file()
    assert (target / "metadata.yaml").is_file()
    assert (target / "README.md").is_file()
