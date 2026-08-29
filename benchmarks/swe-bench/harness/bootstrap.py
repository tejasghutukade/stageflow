from __future__ import annotations

import json
from pathlib import Path

from docker.models.containers import Container

from .config import HarnessConfig
from .docker import DockerManager, ExecResult

NODE_VERSION = "20.18.0"
NODE_DIR = f"/opt/node-v{NODE_VERSION}-linux-x64"
BOOTSTRAP_MARKER = ".stageflow-node-bootstrap"


def bootstrap_marker_path(config: HarnessConfig, worker_store_host: Path) -> Path:
    return worker_store_host / BOOTSTRAP_MARKER


def is_bootstrapped(config: HarnessConfig, worker_store_host: Path) -> bool:
    marker = bootstrap_marker_path(config, worker_store_host)
    if not marker.is_file():
        return False
    try:
        data = json.loads(marker.read_text(encoding="utf-8"))
        return data.get("node_version") == NODE_VERSION
    except (json.JSONDecodeError, OSError):
        return False


def mark_bootstrapped(config: HarnessConfig, worker_store_host: Path) -> None:
    worker_store_host.mkdir(parents=True, exist_ok=True)
    marker = bootstrap_marker_path(config, worker_store_host)
    marker.write_text(
        json.dumps({"node_version": NODE_VERSION}, indent=2),
        encoding="utf-8",
    )


def ensure_node(container: Container, docker: DockerManager, config: HarnessConfig) -> ExecResult:
    check = docker.exec(container, "command -v node && node --version")
    if check.returncode == 0 and check.stdout.strip():
        return check

    install_script = f"""
set -euo pipefail
if [ -x {NODE_DIR}/bin/node ]; then
  ln -sf {NODE_DIR}/bin/node /usr/local/bin/node
  ln -sf {NODE_DIR}/bin/npm /usr/local/bin/npm
  node --version
  exit 0
fi
apt-get update -qq
apt-get install -y -qq curl ca-certificates xz-utils >/dev/null
curl -fsSL https://nodejs.org/dist/v{NODE_VERSION}/node-v{NODE_VERSION}-linux-x64.tar.xz \\
  | tar -xJ -C /opt
ln -sf {NODE_DIR}/bin/node /usr/local/bin/node
ln -sf {NODE_DIR}/bin/npm /usr/local/bin/npm
node --version
"""
    return docker.exec(container, install_script)


def ensure_stageflow_cli(
    container: Container,
    docker: DockerManager,
    config: HarnessConfig,
) -> ExecResult:
    cli = f"{config.container_stageflow_mount}/dist/cli.js"
    return docker.exec(
        container,
        f"test -f {cli} && node {cli} --help >/dev/null",
    )


def bootstrap_container(
    container: Container,
    docker: DockerManager,
    config: HarnessConfig,
    worker_store_host: Path,
) -> None:
    if is_bootstrapped(config, worker_store_host):
        result = ensure_stageflow_cli(container, docker, config)
        if result.returncode == 0:
            return

    node_result = ensure_node(container, docker, config)
    if node_result.returncode != 0:
        raise RuntimeError(
            f"Node bootstrap failed: {node_result.stderr or node_result.stdout}",
        )

    cli_result = ensure_stageflow_cli(container, docker, config)
    if cli_result.returncode != 0:
        raise RuntimeError(
            "Stageflow dist/cli.js not found. Run `npm run build` at the repo root before batch runs.",
        )

    mark_bootstrapped(config, worker_store_host)
