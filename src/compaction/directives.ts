import { ASK_OPERATOR_TOOL_NAME, EMIT_STAGE_ENVELOPE_TOOL_NAME } from "../tools/stageToolNames.js";
import type { LooseMessage } from "./pin.js";
import { scrubSecrets } from "./scrub.js";

export type DirectiveSource = "operator" | "user" | "rejection";

/** Words from the people running the work, copied verbatim so a summary cannot reword a decision. */
export type Directive = { source: DirectiveSource; text: string };

export const DIRECTIVE_MAX_CHARS = 600;
export const USER_DIRECTIVE_MAX_CHARS = 280;
export const DIRECTIVES_CARRY_MAX = 60;

const NOISE_USER = /^(?:Begin this stage\b|Reminder \d+ of \d+|Continue this stage after feedback-loop)/i;
const OPERATOR_TOOLS = new Set([ASK_OPERATOR_TOOL_NAME]);
const ENVELOPE_TOOLS = new Set([EMIT_STAGE_ENVELOPE_TOOL_NAME]);

function blocksText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (b !== null && typeof b === "object" && (b as { type?: unknown }).type === "text" && typeof (b as { text?: unknown }).text === "string" ? (b as { text: string }).text : ""))
    .filter(Boolean)
    .join("\n");
}

function clip(text: string, max = DIRECTIVE_MAX_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Operator answers, rejected emits and user messages, in order. The stage kickoff and reminder prompts are
 * skipped: they carry no decision.
 */
export function extractDirectives(messages: readonly LooseMessage[]): Directive[] {
  const out: Directive[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      const text = blocksText(m.content);
      if (!text.trim() || NOISE_USER.test(text.trim())) continue;
      out.push({ source: "user", text: clip(scrubSecrets(text), USER_DIRECTIVE_MAX_CHARS) });
    } else if (m.role === "toolResult") {
      const name = typeof m.toolName === "string" ? m.toolName : "";
      const text = blocksText(m.content);
      if (!text.trim()) continue;
      if (OPERATOR_TOOLS.has(name)) out.push({ source: "operator", text: clip(scrubSecrets(text)) });
      else if (ENVELOPE_TOOLS.has(name) && m.isError === true) out.push({ source: "rejection", text: clip(scrubSecrets(text)) });
    }
  }
  return out;
}

export function mergeDirectives(previous: readonly Directive[], fresh: readonly Directive[], max = DIRECTIVES_CARRY_MAX): Directive[] {
  const seen = new Set<string>();
  const merged: Directive[] = [];
  for (const d of [...previous, ...fresh]) {
    const key = `${d.source}\u0000${d.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(d);
  }
  return merged.slice(-max);
}

const LABEL: Record<DirectiveSource, string> = { operator: "Operator", user: "User", rejection: "Rejected" };

const DIRECTIVE_WORDS =
  /\b(?:always|never|must|should|shall|don'?t|do not|cannot|can'?t|only|prefer|require[sd]?|approved?|rejected?|decid(?:e|ed|ion)|deadline|due|before|after|until|instead|budget|limit|forbidden|allowed|use|avoid|ensure|remember|important)\b/i;
const SHORT_MESSAGE_CHARS = 160;

/** Instruction-like or short messages outrank long prose, so filler cannot crowd out a rule. */
function isDirectiveLike(d: Directive): boolean {
  if (d.source !== "user") return true;
  return d.text.length <= SHORT_MESSAGE_CHARS || DIRECTIVE_WORDS.test(d.text);
}

/** Directive-like entries first (newest up to 60% of the budget, then oldest), then the rest if room remains. */
export function renderDirectives(directives: readonly Directive[], maxChars: number): string {
  if (directives.length === 0) return "";
  const header = "## Operator and user directives (verbatim, oldest first)";
  const lineOf = (d: Directive) => `- ${LABEL[d.source]}: ${d.text}`;
  const picked = new Set<number>();
  let used = header.length;
  const take = (i: number, limit: number): boolean => {
    const cost = lineOf(directives[i]!).length + 1;
    if (used + cost > limit) return false;
    picked.add(i);
    used += cost;
    return true;
  };
  const primary = directives.map((d, i) => (isDirectiveLike(d) ? i : -1)).filter((i) => i >= 0);
  const secondary = directives.map((d, i) => (isDirectiveLike(d) ? -1 : i)).filter((i) => i >= 0);
  const newestLimit = Math.floor(maxChars * 0.6);
  for (let k = primary.length - 1; k >= 0; k--) if (!take(primary[k]!, newestLimit)) break;
  for (const i of primary) {
    if (picked.has(i)) continue;
    if (!take(i, maxChars)) break;
  }
  for (const i of secondary) {
    if (!take(i, maxChars)) break;
  }
  if (picked.size === 0) return "";
  const lines: string[] = [];
  let gap = false;
  for (let i = 0; i < directives.length; i++) {
    if (picked.has(i)) {
      if (gap) lines.push("- (…)");
      gap = false;
      lines.push(lineOf(directives[i]!));
    } else if (lines.length > 0) gap = true;
  }
  const omitted = directives.length - picked.size;
  return [header, ...lines, ...(omitted > 0 ? [`- (${omitted} omitted for space)`] : [])].join("\n");
}
