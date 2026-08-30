from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class HarnessConfig:
    stageflow_root: Path
    output_dir: Path
    pipeline: Path
    model_name_or_path: str = "stageflow/claude-sonnet-4-5"
    subset: str = "lite"
    split: str = "dev"
    workers: int = 1
    resume: bool = False
    timeout_seconds: int = 3600
    instance_ids: list[str] | None = None
    slice_spec: str | None = None
    dry_run: bool = False
    env_keys: list[str] = field(
        default_factory=lambda: [
            "ANTHROPIC_API_KEY",
            "OPENAI_API_KEY",
            "OPENAI_BASE_URL",
            "CURSOR_API_KEY",
        ]
    )

    @property
    def container_stageflow_mount(self) -> str:
        return "/opt/stageflow"

    @property
    def container_output_mount(self) -> str:
        return "/output"

    @property
    def container_checkout(self) -> str:
        return "/testbed"

    def pipeline_container_path(self) -> str:
        rel = self.pipeline.resolve().relative_to(self.stageflow_root.resolve())
        return f"{self.container_stageflow_mount}/{rel.as_posix()}"

    def worker_store_root(self, worker_id: int) -> Path:
        return self.output_dir / "workers" / str(worker_id) / ".stageflow"

    def instances_dir(self) -> Path:
        return self.output_dir / "instances"

    def trajs_dir(self) -> Path:
        return self.output_dir / "trajs"

    def preds_jsonl_path(self) -> Path:
        return self.output_dir / "all_preds.jsonl"

    def preds_json_path(self) -> Path:
        return self.output_dir / "preds.json"


def find_stageflow_root(start: Path | None = None) -> Path:
    current = (start or Path.cwd()).resolve()
    for candidate in [current, *current.parents]:
        if (candidate / "package.json").is_file() and (candidate / "src" / "cli.ts").is_file():
            return candidate
    raise RuntimeError(
        "Could not locate Stageflow repository root (expected package.json and src/cli.ts)",
    )


def ensure_stageflow_built(root: Path) -> Path:
    cli = root / "dist" / "cli.js"
    if not cli.is_file():
        raise RuntimeError(
            f"Stageflow is not built: missing {cli}\n"
            "From the repository root run:\n"
            "  npm install\n"
            "  npm run build\n"
            "Then verify: ls dist/cli.js",
        )
    return cli
