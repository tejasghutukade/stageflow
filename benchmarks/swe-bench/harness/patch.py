from __future__ import annotations

from docker.models.containers import Container

from .config import HarnessConfig
from .docker import DockerManager


def extract_patch(container: Container, docker: DockerManager, config: HarnessConfig) -> str:
    result = docker.exec(
        container,
        f"git -C {config.container_checkout} diff",
        workdir=config.container_checkout,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"git diff failed: {result.stderr or result.stdout}",
        )
    return normalize_patch(result.stdout)


def normalize_patch(patch: str) -> str:
    text = patch.replace("\r\n", "\n")
    if not text.strip():
        return ""
    if not text.endswith("\n"):
        text += "\n"
    return text
