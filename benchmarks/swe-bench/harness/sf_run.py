from __future__ import annotations

from typing import Any


def extract_sf_reason(sf_run: dict[str, Any] | None) -> str | None:
    if not sf_run:
        return None
    reason = sf_run.get("reason")
    if isinstance(reason, str) and reason.strip():
        return reason
    findings = sf_run.get("findings")
    if isinstance(findings, list):
        for item in findings:
            if not isinstance(item, dict):
                continue
            message = item.get("message")
            if isinstance(message, str) and message.strip():
                return message
    return None
