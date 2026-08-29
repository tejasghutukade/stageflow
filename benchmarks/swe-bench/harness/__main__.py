from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .batch import run_batch
from .config import HarnessConfig, find_stageflow_root
from .grade import grade_cloud, grade_local
from .submit import package_submission


def _default_pipeline(root: Path) -> Path:
    return root / "benchmarks" / "swe-bench" / "pipelines" / "stub.pipeline.yaml"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="swe-bench-harness")
    sub = parser.add_subparsers(dest="command", required=True)

    batch = sub.add_parser("batch", help="Run Stageflow over SWE-bench instances")
    batch.add_argument("--subset", choices=["lite", "verified"], default="lite")
    batch.add_argument("--split", choices=["dev", "test"], default="dev")
    batch.add_argument("--workers", type=int, default=1)
    batch.add_argument("--output-dir", type=Path, required=True)
    batch.add_argument("--pipeline", type=Path, default=None)
    batch.add_argument("--model-name-or-path", default="stageflow/claude-sonnet-4-5")
    batch.add_argument("--instance-ids", nargs="*", default=None)
    batch.add_argument("--slice", dest="slice_spec", default=None)
    batch.add_argument("--resume", action="store_true")
    batch.add_argument("--dry-run", action="store_true")

    grade = sub.add_parser("grade", help="Grade predictions with official SWE-bench tooling")
    grade.add_argument("--output-dir", type=Path, required=True)
    grade.add_argument("--subset", choices=["lite", "verified"], default="lite")
    grade.add_argument("--split", choices=["dev", "test"], default="dev")
    grade.add_argument("--run-id", required=True)
    grade.add_argument("--workers", type=int, default=4)
    grade.add_argument("--cloud", action="store_true", help="Use sb-cli instead of local swebench eval")

    submit = sub.add_parser("submit", help="Package a leaderboard submission folder")
    submit.add_argument("--output-dir", type=Path, required=True)
    submit.add_argument("--subset", choices=["lite", "verified"], default="lite")
    submit.add_argument("--name", default=None)
    submit.add_argument("--dest", type=Path, default=None)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    root = find_stageflow_root()

    if args.command == "batch":
        pipeline = args.pipeline or _default_pipeline(root)
        config = HarnessConfig(
            stageflow_root=root,
            output_dir=args.output_dir.resolve(),
            pipeline=pipeline.resolve(),
            model_name_or_path=args.model_name_or_path,
            subset=args.subset,
            split=args.split,
            workers=args.workers,
            resume=args.resume,
            instance_ids=args.instance_ids,
            slice_spec=args.slice_spec,
            dry_run=args.dry_run,
        )
        summary = run_batch(config)
        print(json.dumps(summary, indent=2))
        return 0

    if args.command == "grade":
        config = HarnessConfig(
            stageflow_root=root,
            output_dir=args.output_dir.resolve(),
            pipeline=_default_pipeline(root),
            subset=args.subset,
            split=args.split,
        )
        if args.cloud:
            return grade_cloud(config, run_id=args.run_id)
        return grade_local(config, run_id=args.run_id, workers=args.workers)

    if args.command == "submit":
        config = HarnessConfig(
            stageflow_root=root,
            output_dir=args.output_dir.resolve(),
            pipeline=_default_pipeline(root),
            subset=args.subset,
        )
        target = package_submission(config, submission_name=args.name, dest_root=args.dest)
        print(str(target))
        return 0

    parser.error(f"Unknown command: {args.command}")
    return 2


if __name__ == "__main__":
    sys.exit(main())
