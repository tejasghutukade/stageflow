from __future__ import annotations

import io
import shutil
import tarfile
from pathlib import Path

POPULATED_MARKER = ".swe-bench-testbed-populated"


def is_testbed_populated(testbed_host: Path, image: str) -> bool:
    marker = testbed_host / POPULATED_MARKER
    return (
        (testbed_host / ".git").is_dir()
        and marker.is_file()
        and marker.read_text(encoding="utf-8").strip() == image
    )


def ensure_testbed_ready(testbed_host: Path) -> None:
    if (testbed_host / ".git").is_dir():
        return
    raise RuntimeError(
        f"SWE-bench testbed is missing at {testbed_host}. "
        "Ensure Docker is running, then pull the eval image or rerun with a fresh --output-dir.",
    )


def populate_host_testbed(image: str, testbed_host: Path, docker_client) -> None:
    if is_testbed_populated(testbed_host, image):
        return

    if testbed_host.exists():
        shutil.rmtree(testbed_host)

    testbed_host.mkdir(parents=True, exist_ok=True)
    container = docker_client.containers.create(image, command=["sleep", "infinity"])
    try:
        stream, _stat = container.get_archive("/testbed")
        file_obj = io.BytesIO()
        for chunk in stream:
            file_obj.write(chunk)
        file_obj.seek(0)
        with tarfile.open(fileobj=file_obj) as tar:
            tar.extractall(path=testbed_host.parent, filter="data")
    finally:
        container.remove(force=True)

    (testbed_host / POPULATED_MARKER).write_text(image, encoding="utf-8")
