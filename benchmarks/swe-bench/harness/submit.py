from __future__ import annotations

import json
import shutil
from datetime import date
from pathlib import Path

from .config import HarnessConfig


def package_submission(
    config: HarnessConfig,
    *,
    submission_name: str | None = None,
    dest_root: Path | None = None,
) -> Path:
    stamp = date.today().strftime("%Y%m%d")
    folder_name = submission_name or f"{stamp}_stageflow_{config.subset}"
    base = dest_root or (config.output_dir / "submission")
    target = base / config.subset / folder_name
    target.mkdir(parents=True, exist_ok=True)

    preds_jsonl = config.preds_jsonl_path()
    preds_json = config.preds_json_path()
    if preds_jsonl.is_file():
        shutil.copy2(preds_jsonl, target / "all_preds.jsonl")
    if preds_json.is_file():
        shutil.copy2(preds_json, target / "preds.json")

    template = (
        config.stageflow_root
        / "benchmarks"
        / "swe-bench"
        / "config"
        / "metadata.yaml.template"
    )
    if template.is_file():
        shutil.copy2(template, target / "metadata.yaml")

    trajs_src = config.trajs_dir()
    if trajs_src.is_dir():
        trajs_dest = target / "trajs"
        trajs_dest.mkdir(parents=True, exist_ok=True)
        for trace in trajs_src.glob("*"):
            if trace.is_file():
                shutil.copy2(trace, trajs_dest / trace.name)

    logs_src = config.output_dir / "logs"
    if logs_src.is_dir():
        logs_dest = target / "logs"
        if logs_dest.exists():
            shutil.rmtree(logs_dest)
        shutil.copytree(logs_src, logs_dest)

    readme = target / "README.md"
    readme.write_text(
        "\n".join(
            [
                f"# {folder_name}",
                "",
                "Stageflow SWE-bench submission package.",
                "",
                "## Checklist",
                "",
                "- [ ] Pass@1 submission",
                "- [ ] No SWE-bench test oracle fields used during inference",
                "- [ ] Reasoning traces included under `trajs/`",
                "- [ ] Technical report linked in `metadata.yaml`",
                "",
                "## Notes",
                "",
                "SWE-bench Verified and Multilingual require academic affiliation and an open",
                "publication for official leaderboard acceptance (policy since 2025-11-18).",
                "",
            ],
        ),
        encoding="utf-8",
    )

    manifest = {
        "submission_dir": str(target),
        "preds_jsonl": str(preds_jsonl),
        "trace_count": len(list((target / "trajs").glob("*"))) if (target / "trajs").is_dir() else 0,
    }
    (target / "submission-manifest.json").write_text(
        json.dumps(manifest, indent=2),
        encoding="utf-8",
    )
    return target
