from __future__ import annotations

import os
import shlex
import subprocess
from dataclasses import dataclass
from typing import Mapping

import docker
from docker.models.containers import Container

from .config import HarnessConfig


@dataclass
class ExecResult:
    returncode: int
    stdout: str
    stderr: str


class DockerManager:
    def __init__(self, config: HarnessConfig) -> None:
        self.config = config
        self.client = docker.from_env()

    def pull_image(self, image: str) -> None:
        self.client.images.pull(image)

    def container_name(self, instance_id: str) -> str:
        safe = instance_id.replace("/", "-").replace(":", "-")
        return f"stageflow-swe-{safe}"

    def start_container(
        self,
        instance_id: str,
        image: str,
        instance_output_dir: str,
        worker_store_host: str,
    ) -> Container:
        name = self.container_name(instance_id)
        self._remove_existing(name)

        env = self._collect_env()
        volumes = {
            str(self.config.stageflow_root.resolve()): {
                "bind": self.config.container_stageflow_mount,
                "mode": "rw",
            },
            instance_output_dir: {
                "bind": self.config.container_output_mount,
                "mode": "rw",
            },
            worker_store_host: {
                "bind": f"{self.config.container_stageflow_mount}/.stageflow",
                "mode": "rw",
            },
        }

        home_stageflow = os.path.expanduser("~/.stageflow")
        if os.path.isdir(home_stageflow):
            volumes[home_stageflow] = {
                "bind": "/root/.stageflow",
                "mode": "ro",
            }

        container = self.client.containers.run(
            image,
            command=["sleep", "infinity"],
            name=name,
            detach=True,
            remove=False,
            volumes=volumes,
            environment=env,
            working_dir=self.config.container_checkout,
        )
        return container

    def exec(
        self,
        container: Container,
        command: str | list[str],
        *,
        workdir: str | None = None,
        timeout: int | None = None,
    ) -> ExecResult:
        if isinstance(command, str):
            cmd = ["bash", "-lc", command]
        else:
            cmd = command
        try:
            exit_code, output = container.exec_run(
                cmd,
                workdir=workdir,
                demux=True,
                environment=self._collect_env(),
            )
        except Exception as err:
            return ExecResult(returncode=125, stdout="", stderr=str(err))

        stdout_bytes, stderr_bytes = output if output else (b"", b"")
        stdout = (stdout_bytes or b"").decode("utf-8", errors="replace")
        stderr = (stderr_bytes or b"").decode("utf-8", errors="replace")
        if timeout is not None and exit_code != 0 and "timeout" in stderr.lower():
            return ExecResult(returncode=124, stdout=stdout, stderr=stderr)
        return ExecResult(returncode=exit_code, stdout=stdout, stderr=stderr)

    def stop_and_remove(self, container: Container) -> None:
        try:
            container.stop(timeout=10)
        finally:
            container.remove(force=True)

    def _remove_existing(self, name: str) -> None:
        try:
            existing = self.client.containers.get(name)
        except docker.errors.NotFound:
            return
        existing.remove(force=True)

    def _collect_env(self) -> Mapping[str, str]:
        out: dict[str, str] = {}
        for key in self.config.env_keys:
            value = os.environ.get(key)
            if value:
                out[key] = value
        out.setdefault("HOME", "/root")
        return out


def shell_join(args: list[str]) -> str:
    return " ".join(shlex.quote(part) for part in args)
