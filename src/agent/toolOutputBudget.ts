/**
 * Per-result decision: keep a tool result inline, or spill it to a stage
 * artifact. Pure; see toolOutputBudgetExtension for the Pi wiring.
 */

export const TOOL_OUTPUT_HARD_CEILING_BYTES = 8 * 1024 * 1024;

export const BYTES_PER_TOKEN = 3;
export const RESERVE_MIN_TOKENS = 16_000;
export const RESERVE_FRACTION = 0.25;
export const PER_RESULT_MAX_FRACTION = 0.3;
export const UNKNOWN_USAGE_INLINE_MAX_BYTES = 50 * 1024;
export const IMAGE_BLOCK_EST_TOKENS = 1_500;
export const PREVIEW_MAX_BYTES = 2 * 1024;

export type BudgetInput = {
  resultBytes: number;
  contextWindow: number;
  knownTokens: number | null;
  turnLedgerTokens: number;
};

export type SpillReason =
  | "exceeds_remaining"
  | "exceeds_per_result_cap"
  | "unknown_usage_fallback"
  | "adapter_truncated";

export type BudgetDecision =
  | { kind: "inline"; estTokens: number }
  | { kind: "spill"; estTokens: number; reason: SpillReason };

export function estimateTokens(bytes: number): number {
  return Math.ceil(Math.max(0, bytes) / BYTES_PER_TOKEN);
}

export function decideToolOutput(input: BudgetInput): BudgetDecision {
  const estTokens = estimateTokens(input.resultBytes);
  const window = input.contextWindow;
  if (input.knownTokens === null || !Number.isFinite(window) || window <= 0) {
    return input.resultBytes <= UNKNOWN_USAGE_INLINE_MAX_BYTES
      ? { kind: "inline", estTokens }
      : { kind: "spill", estTokens, reason: "unknown_usage_fallback" };
  }
  if (estTokens > PER_RESULT_MAX_FRACTION * window) {
    return { kind: "spill", estTokens, reason: "exceeds_per_result_cap" };
  }
  const reserve = Math.max(RESERVE_MIN_TOKENS, RESERVE_FRACTION * window);
  const remaining =
    window - input.knownTokens - input.turnLedgerTokens - reserve;
  if (estTokens > remaining) {
    return { kind: "spill", estTokens, reason: "exceeds_remaining" };
  }
  return { kind: "inline", estTokens };
}

export function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

export function truncateUtf8(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) return text;
  let end = Math.max(0, Math.floor(maxBytes));
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString("utf8");
}

export function tryParseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  const trimmed = text.trim();
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch {
    return { ok: false };
  }
}

const SHAPE_MAX_KEYS = 20;

function describeValue(value: unknown): string {
  if (Array.isArray(value)) return `array(${value.length})`;
  if (value === null) return "null";
  if (typeof value === "object") {
    return `object(${Object.keys(value as Record<string, unknown>).length} keys)`;
  }
  if (typeof value === "string") return `string(${value.length} chars)`;
  return typeof value;
}

export function describeJsonShape(value: unknown): string {
  if (Array.isArray(value)) {
    const first = value.length > 0 ? `; first item: ${describeValue(value[0])}` : "";
    return `JSON array with ${value.length} items${first}`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    const shown = entries
      .slice(0, SHAPE_MAX_KEYS)
      .map(([key, child]) => `${key}: ${describeValue(child)}`);
    const more =
      entries.length > SHAPE_MAX_KEYS
        ? `, … ${entries.length - SHAPE_MAX_KEYS} more keys`
        : "";
    return `JSON object { ${shown.join(", ")}${more} }`;
  }
  return `JSON ${describeValue(value)}`;
}

/**
 * Short model-facing preview of a spilled body. `body` is the normalized text
 * that was written to disk, so preview line numbers match what `read` pages.
 */
export function buildPreview(
  body: string,
  options: { json?: unknown; maxBytes?: number } = {},
): string {
  const maxBytes = options.maxBytes ?? PREVIEW_MAX_BYTES;
  const shape =
    options.json !== undefined ? `Shape: ${describeJsonShape(options.json)}\n` : "";
  const head = truncateUtf8(body, Math.max(0, maxBytes - utf8ByteLength(shape)));
  const ellipsis = head.length < body.length ? "\n…" : "";
  return `${shape}Preview:\n${head}${ellipsis}`;
}
