import type { LooseMessage } from "./pin.js";
import { scrubSecrets } from "./scrub.js";
import { classifyForClearing } from "./toolPolicy.js";
import type { ClearedResult } from "./types.js";

export type ClearingPolicy = {
  /** Never touch results at or after the Nth assistant turn from the end. */
  keepRecentTurns: number;
  /** Ignore results smaller than this many UTF-8 bytes. */
  minBytes: number;
  /** Overrides the default recover hint when it returns a non-empty string. */
  recoverHintFor?: (message: LooseMessage) => string | undefined;
};

export type ClearingPlan = { cleared: ClearedResult[]; clearIds: Set<string> };

const PLACEHOLDER_PREFIX = "[Tool result cleared to save context:";
const DESCRIPTOR_MAX = 100;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function resultText(message: LooseMessage): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const block of content) {
    const b = record(block);
    if (b?.type === "text" && typeof b.text === "string") out += (out ? "\n" : "") + b.text;
  }
  return out;
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function findToolCall(messages: readonly LooseMessage[], before: number, toolCallId: string): Record<string, unknown> | undefined {
  for (let i = before - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const block of m.content) {
      const b = record(block);
      if (b?.type === "toolCall" && b.id === toolCallId) return b;
    }
  }
  return undefined;
}

function callArgs(call: Record<string, unknown> | undefined): Record<string, unknown> {
  return record(call?.arguments) ?? {};
}

function describe(toolName: string, args: Record<string, unknown>): string {
  const pathArg = typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : undefined;
  if (pathArg) return oneLine(`${toolName} ${pathArg}`, DESCRIPTOR_MAX);
  if (typeof args.command === "string") return oneLine(`${toolName}: ${args.command}`, DESCRIPTOR_MAX);
  if (typeof args.pattern === "string") return oneLine(`${toolName} ${args.pattern}${typeof args.path === "string" ? ` in ${args.path}` : ""}`, DESCRIPTOR_MAX);
  const keys = Object.keys(args);
  if (keys.length === 0) return toolName;
  let json = "";
  try {
    json = JSON.stringify(args);
  } catch {
    json = "";
  }
  return oneLine(json ? `${toolName} ${json}` : toolName, DESCRIPTOR_MAX);
}

function defaultHint(message: LooseMessage, toolName: string, args: Record<string, unknown>): string {
  const spill = record(record(message.details)?.stageflowToolOutput);
  const spillPath = typeof spill?.path === "string" ? spill.path : undefined;
  if (spillPath) return `read ${spillPath}`;
  if (toolName === "read") {
    const p = typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : undefined;
    if (p) return `read ${p} (offset/limit as before)`;
  }
  return `re-run ${toolName} with the same arguments`;
}

function isPlaceholder(text: string): boolean {
  return text.startsWith(PLACEHOLDER_PREFIX);
}

export function planClearing(messages: readonly LooseMessage[], policy: ClearingPolicy): ClearingPlan {
  const cleared: ClearedResult[] = [];
  const clearIds = new Set<string>();

  let boundary = messages.length;
  if (policy.keepRecentTurns > 0) {
    let seen = 0;
    boundary = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]!.role === "assistant" && ++seen === policy.keepRecentTurns) {
        boundary = i;
        break;
      }
    }
  }

  for (let i = 0; i < boundary; i++) {
    const m = messages[i]!;
    if (m.role !== "toolResult") continue;
    const toolCallId = typeof m.toolCallId === "string" ? m.toolCallId : undefined;
    const toolName = typeof m.toolName === "string" ? m.toolName : undefined;
    if (!toolCallId || !toolName || clearIds.has(toolCallId)) continue;
    if (classifyForClearing(toolName, m.isError === true, m.details) !== "clearable") continue;
    const text = resultText(m);
    if (isPlaceholder(text)) continue;
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes < policy.minBytes) continue;
    const args = callArgs(findToolCall(messages, i, toolCallId));
    const custom = policy.recoverHintFor?.(m);
    cleared.push({
      toolName,
      toolCallId,
      bytes,
      descriptor: scrubSecrets(describe(toolName, args)),
      recoverHint: scrubSecrets(custom && custom.trim().length > 0 ? oneLine(custom, 300) : defaultHint(m, toolName, args)),
    });
    clearIds.add(toolCallId);
  }
  return { cleared, clearIds };
}

export function placeholderFor(item: ClearedResult): string {
  return `${PLACEHOLDER_PREFIX} ${item.descriptor}, ${item.bytes} bytes. To get it again: ${item.recoverHint}]`;
}

export function applyClearing<T extends LooseMessage>(messages: readonly T[], plan: ClearingPlan): T[] {
  if (plan.clearIds.size === 0) return [...messages];
  const byId = new Map(plan.cleared.map((c) => [c.toolCallId, c]));
  return messages.map((m) => {
    if (m.role !== "toolResult" || typeof m.toolCallId !== "string" || !plan.clearIds.has(m.toolCallId)) return m;
    const item = byId.get(m.toolCallId);
    if (!item || isPlaceholder(resultText(m))) return m;
    return { ...m, content: [{ type: "text", text: placeholderFor(item) }] };
  });
}

export function renderClearedIndex(cleared: readonly ClearedResult[], maxChars: number): string {
  const title = "## Cleared tool results (re-fetch if needed)";
  const omitted = (n: number) => `- (${n} more omitted)`;
  if (cleared.length === 0) return title;
  const reserve = omitted(cleared.length).length + 1;
  const lines: string[] = [];
  let used = title.length;
  for (const item of cleared) {
    const line = `- ${item.descriptor} (${item.bytes} bytes) — ${oneLine(item.recoverHint, 200)}`;
    if (used + line.length + 1 + reserve > maxChars) break;
    lines.push(line);
    used += line.length + 1;
  }
  const out = [title, ...lines];
  if (lines.length < cleared.length) out.push(omitted(cleared.length - lines.length));
  return out.join("\n").slice(0, Math.max(maxChars, 0));
}
