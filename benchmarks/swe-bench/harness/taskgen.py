from __future__ import annotations

from pathlib import Path

from jinja2 import Template

from .config import HarnessConfig
from .dataset import SweBenchInstance

TEMPLATE_PATH = Path(__file__).resolve().parent.parent / "tasks" / "template.task.yaml"


def render_task(instance: SweBenchInstance, config: HarnessConfig, out_path: Path) -> Path:
    template_text = TEMPLATE_PATH.read_text(encoding="utf-8")
    template = Template(template_text)
    rendered = template.render(
        instance_id=instance.instance_id,
        repo=instance.repo,
        base_commit=instance.base_commit,
        problem_statement=instance.problem_statement,
    )
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(rendered, encoding="utf-8")
    return out_path


def task_container_path(config: HarnessConfig) -> str:
    return f"{config.container_output_mount}/task.yaml"
