import type { RunSummary, StageLogEvent } from "../../api";
import type { CatalogSnapshot } from "../../catalog/source";
export function workspaceLabelFromSnapshot(snapshot: CatalogSnapshot): {
  name: string;
  subtitle?: string;
} {
  const run = snapshot.runs.find((r) => r.project_root) ?? snapshot.runs[0];
  if (!run?.project_root) {
    return { name: "Stageflow" };
  }
  const root = run.project_root.replace(/\\/g, "/");
  const parts = root.split("/").filter(Boolean);
  const folder = parts[parts.length - 1];
  return {
    name: "Stageflow",
    subtitle: folder && folder !== "." ? folder : undefined,
  };
}

export function gateRationaleFromEvents(events: StageLogEvent[]): string | null {
  let lastAssistant: string | null = null;
  for (const ev of events) {
    if (ev.event === "operator_prompt") break;
    if (ev.event === "message" && ev.role === "assistant" && typeof ev.text === "string") {
      const trimmed = ev.text.trim();
      if (trimmed) lastAssistant = trimmed;
    }
  }
  return lastAssistant;
}

export function formatRunElapsed(run: RunSummary, now = Date.now()): string | null {
  const start = Date.parse(run.created_at);
  if (Number.isNaN(start)) return null;
  const end = run.finished_at ? Date.parse(run.finished_at) : now;
  const ms = Math.max(0, end - start);
  const sec = Math.floor(ms / 1000);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m >= 60) {
    const h = Math.floor(m / 60);
    const rm = m % 60;
    return `${h}h ${rm}m`;
  }
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function wrapGateIndex(index: number, total: number): number {
  if (total <= 0) return 0;
  return ((index % total) + total) % total;
}

export function nextGateIndex(index: number, total: number, delta: 1 | -1): number {
  return wrapGateIndex(index + delta, total);
}
