from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterator

INFERENCE_FORBIDDEN_FIELDS = frozenset(
    {
        "patch",
        "test_patch",
        "FAIL_TO_PASS",
        "PASS_TO_PASS",
        "hints_text",
        "hints",
    },
)

DATASET_MAP = {
    ("lite", "dev"): ("SWE-bench/SWE-bench_Lite", "dev"),
    ("lite", "test"): ("SWE-bench/SWE-bench_Lite", "test"),
    ("verified", "test"): ("SWE-bench/SWE-bench_Verified", "test"),
    ("verified", "dev"): ("SWE-bench/SWE-bench_Verified", "dev"),
}


@dataclass(frozen=True)
class SweBenchInstance:
    instance_id: str
    repo: str
    base_commit: str
    problem_statement: str
    version: str | None = None
    image: str | None = None

    @classmethod
    def from_row(cls, row: dict[str, Any]) -> SweBenchInstance:
        for forbidden in INFERENCE_FORBIDDEN_FIELDS:
            if forbidden in row:
                pass
        instance_id = str(row["instance_id"])
        return cls(
            instance_id=instance_id,
            repo=str(row["repo"]),
            base_commit=str(row["base_commit"]),
            problem_statement=str(row["problem_statement"]),
            version=str(row["version"]) if row.get("version") is not None else None,
            image=str(row["image"]) if row.get("image") is not None else None,
        )


def docker_image_name(instance_id: str) -> str:
    docker_compatible = instance_id.replace("__", "_1776_").lower()
    return f"docker.io/swebench/sweb.eval.x86_64.{docker_compatible}:latest"


def load_instances(
    subset: str,
    split: str,
    instance_ids: list[str] | None = None,
    slice_spec: str | None = None,
) -> list[SweBenchInstance]:
    key = (subset.lower(), split.lower())
    if key not in DATASET_MAP:
        raise ValueError(f"Unsupported subset/split: {subset}/{split}")

    dataset_name, dataset_split = DATASET_MAP[key]

    try:
        from datasets import load_dataset
    except ImportError as err:
        raise RuntimeError(
            "Install harness dependencies: pip install -e benchmarks/swe-bench",
        ) from err

    dataset = load_dataset(dataset_name, split=dataset_split)
    rows = list(dataset)
    instances = [SweBenchInstance.from_row(dict(row)) for row in rows]

    if instance_ids:
        wanted = set(instance_ids)
        instances = [item for item in instances if item.instance_id in wanted]
        missing = wanted - {item.instance_id for item in instances}
        if missing:
            raise ValueError(f"Unknown instance ids: {sorted(missing)}")

    if slice_spec:
        instances = apply_slice(instances, slice_spec)

    return instances


def apply_slice(items: list[SweBenchInstance], slice_spec: str) -> list[SweBenchInstance]:
    if ":" not in slice_spec:
        raise ValueError("Slice must look like start:end, e.g. 0:2")
    start_raw, end_raw = slice_spec.split(":", 1)
    start = int(start_raw) if start_raw else None
    end = int(end_raw) if end_raw else None
    return items[slice(start, end)]
