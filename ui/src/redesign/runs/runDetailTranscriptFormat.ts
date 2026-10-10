import type { ToolCallView } from "./runDetailTranscriptModel";
import { formatDuration } from "../../components/LogPanel";

const TOOL_LABEL_ARG: Record<string, { key: string; isPath: boolean }> = {
  read: { key: "file_path", isPath: true },
  write: { key: "file_path", isPath: true },
  edit: { key: "file_path", isPath: true },
  notebookedit: { key: "notebook_path", isPath: true },
  bash: { key: "command", isPath: false },
  grep: { key: "pattern", isPath: false },
  glob: { key: "pattern", isPath: false },
  webfetch: { key: "url", isPath: false },
  websearch: { key: "query", isPath: false },
};

function parseArgsPreview(
  argsPreview: string | undefined,
): Record<string, unknown> | undefined {
  if (!argsPreview) return undefined;
  try {
    const parsed: unknown = JSON.parse(argsPreview);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractArgValue(
  argsPreview: string | undefined,
  key: string,
): string | undefined {
  const parsed = parseArgsPreview(argsPreview)?.[key];
  if (typeof parsed === "string") return parsed;
  if (!argsPreview) return undefined;
  const match = argsPreview.match(
    new RegExp(`"${escapeRegExp(key)}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`),
  );
  return match ? match[1] : undefined;
}

function basename(value: string): string {
  return value.split("/").pop() || value;
}

export function toolCallArgSummary(call: ToolCallView): string {
  const mapping = TOOL_LABEL_ARG[call.name.toLowerCase()];
  if (!mapping) {
    if (call.args?.trim()) {
      const trimmed = call.args.trim();
      return trimmed.length > 80 ? `${trimmed.slice(0, 77)}…` : trimmed;
    }
    return "";
  }
  const value = extractArgValue(call.args, mapping.key);
  if (typeof value !== "string" || !value.trim()) return "";
  const shown = mapping.isPath ? basename(value) : value;
  return shown.length > 120 ? `${shown.slice(0, 117)}…` : shown;
}

export function toolCallDurationMs(
  call: ToolCallView,
  now: number,
): number | undefined {
  if (!call.startedAt) return undefined;
  const start = Date.parse(call.startedAt);
  if (Number.isNaN(start)) return undefined;
  if (call.status === "running") return Math.max(0, now - start);
  if (!call.at) return undefined;
  const end = Date.parse(call.at);
  if (Number.isNaN(end)) return undefined;
  return Math.max(0, end - start);
}

export function formatToolCallDuration(
  call: ToolCallView,
  now: number,
): string | undefined {
  const ms = toolCallDurationMs(call, now);
  if (ms === undefined) return undefined;
  return formatDuration(ms);
}
