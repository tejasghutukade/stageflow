import { applyClearing, planClearing, renderClearedIndex, type ClearingPolicy } from "./mask.js";
import { extractDirectives, mergeDirectives, renderDirectives, type Directive } from "./directives.js";
import { extractPinnedFacts, renderPinned, scrubSecrets, type LooseMessage } from "./pin.js";
import { COMPACTION_PROMPT_VERSION, type ClearedResult, type PinnedFact, type WorkingStateEntry } from "./types.js";
import { WorkingStateStore } from "./workingState.js";

export const COMPACTION_FOCUS =
  "This is an autonomous agent run, not a chat. Make the summary a working record the agent can continue from without the earlier messages. " +
  "Copy exact identifiers, numbers, counts, timestamps, versions, paths, URLs and quoted error text verbatim; never round, reword or estimate them. " +
  "Keep every failure, rejection and dead end explicit, with why it failed, so it is not retried. " +
  "State what is in flight, which sources or items are already handled and which remain, and the exact next step. " +
  "Keep decisions made by the operator or user and the deliverable the run must produce, including its required format. " +
  "Leave out routine output that carries no decision or value.";

export const SECTIONS_MARKER = "<!-- stageflow:compaction-sections -->";

export const PINNED_RENDER_CHARS = 6000;
export const CLEARED_RENDER_CHARS = 3000;
export const STATE_RENDER_CHARS = 6000;
export const DIRECTIVES_RENDER_CHARS = 5000;
export const PINNED_CARRY_MAX = 400;
export const CLEARED_CARRY_MAX = 200;

export type StageflowCompactionDetails = {
  readFiles?: string[];
  modifiedFiles?: string[];
  stageflowPinned?: PinnedFact[];
  stageflowCleared?: ClearedResult[];
  stageflowDirectives?: Directive[];
  stageflowPromptVersion?: number;
};

/** The sections are always appended last, so the last marker at the start of a line is the real one. */
export function splitSummary(summary: string): { core: string; sections: string } {
  const afterNewline = summary.lastIndexOf(`\n${SECTIONS_MARKER}`);
  const at = afterNewline >= 0 ? afterNewline + 1 : summary.startsWith(SECTIONS_MARKER) ? 0 : -1;
  if (at < 0) return { core: summary, sections: "" };
  return { core: summary.slice(0, at).trimEnd(), sections: summary.slice(at) };
}

const FACT_KINDS = new Set(["id", "number", "timestamp", "url", "path", "error", "other"]);
const DIRECTIVE_SOURCES = new Set(["operator", "user", "rejection"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : undefined;
}

function validPinned(x: unknown): x is PinnedFact {
  return isRecord(x) && typeof x.kind === "string" && FACT_KINDS.has(x.kind) && typeof x.value === "string" && typeof x.context === "string" && isRecord(x.source) && typeof x.source.messageIndex === "number";
}

function validCleared(x: unknown): x is ClearedResult {
  return isRecord(x) && typeof x.toolName === "string" && typeof x.toolCallId === "string" && typeof x.recoverHint === "string" && typeof x.bytes === "number" && typeof x.descriptor === "string";
}

function validDirective(x: unknown): x is Directive {
  return isRecord(x) && typeof x.source === "string" && DIRECTIVE_SOURCES.has(x.source) && typeof x.text === "string";
}

/** Details come from the session file, so anything not shaped like ours is dropped rather than trusted. */
export function readStageflowDetails(value: unknown): StageflowCompactionDetails | undefined {
  if (!isRecord(value)) return undefined;
  const readFiles = strings(value.readFiles);
  const modifiedFiles = strings(value.modifiedFiles);
  return {
    ...(readFiles ? { readFiles } : {}),
    ...(modifiedFiles ? { modifiedFiles } : {}),
    ...(Array.isArray(value.stageflowPinned) ? { stageflowPinned: value.stageflowPinned.filter(validPinned) } : {}),
    ...(Array.isArray(value.stageflowCleared) ? { stageflowCleared: value.stageflowCleared.filter(validCleared) } : {}),
    ...(Array.isArray(value.stageflowDirectives) ? { stageflowDirectives: value.stageflowDirectives.filter(validDirective) } : {}),
    ...(typeof value.stageflowPromptVersion === "number" ? { stageflowPromptVersion: value.stageflowPromptVersion } : {}),
  };
}

function factKey(f: PinnedFact): string {
  return `${f.kind}\u0000${f.value}`;
}

/** Newest facts first win a tie; capped so repeated compactions cannot grow without bound. */
export function mergePinned(previous: readonly PinnedFact[], fresh: readonly PinnedFact[], max = PINNED_CARRY_MAX): PinnedFact[] {
  const seen = new Set<string>();
  const out: PinnedFact[] = [];
  for (const f of [...fresh, ...previous]) {
    const key = factKey(f);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
    if (out.length >= max) break;
  }
  return out;
}

export function mergeCleared(previous: readonly ClearedResult[], fresh: readonly ClearedResult[], max = CLEARED_CARRY_MAX): ClearedResult[] {
  const seen = new Set<string>();
  const out: ClearedResult[] = [];
  for (const c of [...fresh, ...previous]) {
    if (seen.has(c.toolCallId)) continue;
    seen.add(c.toolCallId);
    out.push(c);
    if (out.length >= max) break;
  }
  return out;
}

export function renderSections(input: {
  pinned: readonly PinnedFact[];
  cleared: readonly ClearedResult[];
  state: readonly WorkingStateEntry[];
  directives?: readonly Directive[];
}): string {
  const parts: string[] = [];
  if (input.state.length > 0) {
    const store = new WorkingStateStore();
    for (const e of input.state) store.set({ key: e.key, kind: e.kind, value: e.value, updatedAt: e.updatedAt });
    const rendered = store.render(STATE_RENDER_CHARS);
    if (rendered) parts.push(rendered);
  }
  const directives = renderDirectives(input.directives ?? [], DIRECTIVES_RENDER_CHARS);
  if (directives) parts.push(directives);
  if (input.pinned.length > 0) parts.push(renderPinned(input.pinned, PINNED_RENDER_CHARS));
  if (input.cleared.length > 0) parts.push(renderClearedIndex(input.cleared, CLEARED_RENDER_CHARS));
  if (parts.length === 0) return "";
  return `${SECTIONS_MARKER}\n${parts.join("\n\n")}`;
}

function scrubValue(value: unknown): unknown {
  if (typeof value === "string") return scrubSecrets(value);
  if (Array.isArray(value)) return value.map(scrubValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, scrubValue(v)]));
  }
  return value;
}

/** What the summarizer reads: message text, thinking and tool-call arguments with secrets removed. */
export function redactMessages<T extends LooseMessage>(messages: readonly T[]): T[] {
  return messages.map((m) => (Array.isArray(m.content) || typeof m.content === "string" ? { ...m, content: scrubValue(m.content) } : m)) as T[];
}

export type SummaryInputs = {
  messages: readonly LooseMessage[];
  previousDetails?: StageflowCompactionDetails;
  clearInSummary?: ClearingPolicy;
};

export type PreparedSummaryInputs = {
  messagesForSummarizer: LooseMessage[];
  pinned: PinnedFact[];
  cleared: ClearedResult[];
  directives: Directive[];
};

/** Everything deterministic that happens before the model-written summary is requested. */
export function prepareSummaryInputs(input: SummaryInputs): PreparedSummaryInputs {
  const extracted = extractPinnedFacts(input.messages);
  const pinned = mergePinned(input.previousDetails?.stageflowPinned ?? [], extracted);
  const directives = mergeDirectives(input.previousDetails?.stageflowDirectives ?? [], extractDirectives(input.messages));
  if (!input.clearInSummary) {
    return { messagesForSummarizer: redactMessages(input.messages), pinned, directives, cleared: [...(input.previousDetails?.stageflowCleared ?? [])] };
  }
  const plan = planClearing(input.messages, input.clearInSummary);
  return {
    messagesForSummarizer: redactMessages(applyClearing(input.messages, plan)),
    pinned,
    directives,
    cleared: mergeCleared(input.previousDetails?.stageflowCleared ?? [], plan.cleared),
  };
}

export function stageflowDetails(
  piDetails: { readFiles?: string[]; modifiedFiles?: string[] } | undefined,
  previous: StageflowCompactionDetails | undefined,
  pinned: readonly PinnedFact[],
  cleared: readonly ClearedResult[],
  directives: readonly Directive[] = [],
): StageflowCompactionDetails {
  const union = (a?: string[], b?: string[]) => [...new Set([...(b ?? []), ...(a ?? [])])];
  return {
    readFiles: union(piDetails?.readFiles, previous?.readFiles),
    modifiedFiles: union(piDetails?.modifiedFiles, previous?.modifiedFiles),
    stageflowPinned: [...pinned],
    stageflowCleared: [...cleared],
    stageflowDirectives: [...directives],
    stageflowPromptVersion: COMPACTION_PROMPT_VERSION,
  };
}

export type SummarizeCall = {
  messages: LooseMessage[];
  previousSummary: string | undefined;
};

export type ComposedSummary<R> = {
  summary: string;
  result: R;
  prepared: PreparedSummaryInputs;
};

/**
 * The whole summary pipeline in one place: pin and redact the input, ask the model for the written part,
 * scrub it, then append the deterministic sections. The Pi hook and the evaluation harness both call this,
 * so what the harness measures is what ships.
 */
export async function composeCompactionSummary<R extends { summary: string }>(input: {
  messages: readonly LooseMessage[];
  previousSummary?: string;
  previousDetails?: StageflowCompactionDetails;
  state: readonly WorkingStateEntry[];
  clearInSummary?: ClearingPolicy;
  summarize: (call: SummarizeCall) => Promise<R>;
}): Promise<ComposedSummary<R>> {
  const prepared = prepareSummaryInputs({
    messages: input.messages,
    ...(input.previousDetails ? { previousDetails: input.previousDetails } : {}),
    ...(input.clearInSummary ? { clearInSummary: input.clearInSummary } : {}),
  });
  const result = await input.summarize({
    messages: prepared.messagesForSummarizer,
    previousSummary: input.previousSummary !== undefined ? splitSummary(input.previousSummary).core : undefined,
  });
  const core = scrubSecrets(result.summary).split(SECTIONS_MARKER).join("").trimEnd();
  const sections = renderSections({ pinned: prepared.pinned, cleared: prepared.cleared, state: input.state, directives: prepared.directives });
  return { summary: sections ? `${core}\n\n${sections}` : core, result, prepared };
}
