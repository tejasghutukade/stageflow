import { scrubSecrets } from "./scrub.js";
import type { WorkingStateEntry, WorkingStateKind } from "./types.js";

export const WORKING_STATE_CUSTOM_TYPE = "stageflow.working_state";
export const WORKING_STATE_KINDS: readonly WorkingStateKind[] = [
  "fact",
  "decision",
  "progress",
  "todo",
  "blocker",
];
export const WORKING_STATE_MAX_KEY = 80;
export const WORKING_STATE_MAX_VALUE = 600;
export const WORKING_STATE_MAX_ENTRIES = 60;
export const WORKING_STATE_DEFAULT_RENDER_CHARS = 6000;

export const WORKING_STATE_GUIDANCE =
  "Older messages and tool results are trimmed automatically as the conversation grows, so keep your own working state with the working_state tool. As soon as you learn or decide something you will need later, record it: exact values and identifiers (fact), choices and their reasons (decision), what is done (progress), what remains (todo) and what is stuck (blocker). Keep each entry to one or two short lines, update an existing key instead of adding a duplicate, and delete entries that no longer matter. Never store secrets or credentials in it.";

export type WorkingStateEvent =
  | {
      op: "set";
      key: string;
      kind: WorkingStateKind;
      value: string;
      at: string;
    }
  | { op: "delete"; key: string; at: string };

export type WorkingStateSetResult =
  | { ok: true; dropped: string[]; replaced: boolean; redacted: boolean; entry: WorkingStateEntry }
  | { ok: false; error: string };

export type WorkingStateInput = {
  key: string;
  kind: WorkingStateKind;
  value: string;
  updatedAt?: string;
};

const RENDER_ORDER: readonly WorkingStateKind[] = [
  "blocker",
  "todo",
  "decision",
  "fact",
  "progress",
];
const EVICTION_ORDER: readonly WorkingStateKind[] = [
  "progress",
  "fact",
  "decision",
  "todo",
  "blocker",
];
const HEADINGS: Record<WorkingStateKind, string> = {
  blocker: "Blockers",
  todo: "Todo",
  decision: "Decisions",
  fact: "Facts",
  progress: "Progress",
};

function isKind(value: unknown): value is WorkingStateKind {
  return (
    typeof value === "string" &&
    (WORKING_STATE_KINDS as readonly string[]).includes(value)
  );
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export class WorkingStateStore {
  private readonly entries = new Map<string, WorkingStateEntry>();

  get size(): number {
    return this.entries.size;
  }

  set(input: WorkingStateInput): WorkingStateSetResult {
    if (!isKind(input.kind)) {
      return {
        ok: false,
        error: `kind must be one of ${WORKING_STATE_KINDS.join(", ")}`,
      };
    }
    const rawKey = oneLine(String(input.key ?? ""));
    const rawValue = oneLine(String(input.value ?? ""));
    const key = oneLine(scrubSecrets(rawKey));
    const value = oneLine(scrubSecrets(rawValue));
    const redacted = key !== rawKey || value !== rawValue;
    if (key.length === 0) return { ok: false, error: "key is required" };
    if (key.length > WORKING_STATE_MAX_KEY) {
      return {
        ok: false,
        error: `key is ${key.length} chars; max ${WORKING_STATE_MAX_KEY}`,
      };
    }
    if (value.length === 0) return { ok: false, error: "value is required" };
    if (value.length > WORKING_STATE_MAX_VALUE) {
      return {
        ok: false,
        error: `value is ${value.length} chars; max ${WORKING_STATE_MAX_VALUE}. Shorten it.`,
      };
    }
    const replaced = this.entries.delete(key);
    const dropped: string[] = [];
    while (this.entries.size >= WORKING_STATE_MAX_ENTRIES) {
      const victim = this.oldestOfKind("progress");
      if (victim === undefined) {
        return {
          ok: false,
          error: `working state is full (${WORKING_STATE_MAX_ENTRIES} entries, none are progress). Delete entries first.`,
        };
      }
      this.entries.delete(victim);
      dropped.push(victim);
    }
    const entry: WorkingStateEntry = {
      key,
      kind: input.kind,
      value,
      updatedAt: input.updatedAt ?? new Date().toISOString(),
    };
    this.entries.set(key, entry);
    return { ok: true, dropped, replaced, redacted, entry };
  }

  delete(key: string): boolean {
    const raw = oneLine(String(key ?? ""));
    return this.entries.delete(raw) || this.entries.delete(oneLine(scrubSecrets(raw)));
  }

  list(): WorkingStateEntry[] {
    return [...this.entries.values()];
  }

  apply(event: WorkingStateEvent): void {
    if (event.op === "set") {
      this.set({
        key: event.key,
        kind: event.kind,
        value: event.value,
        updatedAt: event.at,
      });
    } else if (event.op === "delete") {
      this.delete(event.key);
    }
  }

  load(events: readonly WorkingStateEvent[]): void {
    this.entries.clear();
    for (const event of events) this.apply(event);
  }

  render(maxChars: number = WORKING_STATE_DEFAULT_RENDER_CHARS): string {
    const all = this.list();
    if (all.length === 0) return "";
    const keep = new Set(all);
    let omitted = 0;
    const build = (): string => {
      const lines: string[] = ["## Working state"];
      for (const kind of RENDER_ORDER) {
        const group = all.filter((e) => keep.has(e) && e.kind === kind);
        if (group.length === 0) continue;
        lines.push("", `### ${HEADINGS[kind]}`);
        for (const e of group) lines.push(`- ${e.key}: ${e.value}`);
      }
      if (omitted > 0) {
        lines.push("", `(${omitted} older entries omitted for space)`);
      }
      return lines.join("\n");
    };
    let text = build();
    for (const kind of EVICTION_ORDER) {
      for (const e of all) {
        if (text.length <= maxChars) return text;
        if (e.kind !== kind) continue;
        keep.delete(e);
        omitted += 1;
        text = build();
      }
    }
    return text.length <= maxChars ? text : text.slice(0, Math.max(0, maxChars));
  }

  private oldestOfKind(kind: WorkingStateKind): string | undefined {
    for (const e of this.entries.values()) {
      if (e.kind === kind) return e.key;
    }
    return undefined;
  }
}

export function reduceWorkingState(
  events: readonly WorkingStateEvent[],
): WorkingStateStore {
  const store = new WorkingStateStore();
  for (const event of events) store.apply(event);
  return store;
}

type SessionEntryLike = { type?: unknown; customType?: unknown; data?: unknown };

function isEvent(data: unknown): data is WorkingStateEvent {
  if (data === null || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;
  if (typeof d.key !== "string") return false;
  if (d.op === "delete") return true;
  return d.op === "set" && isKind(d.kind) && typeof d.value === "string";
}

export function workingStateEventsFromEntries(
  entries: readonly SessionEntryLike[],
): WorkingStateEvent[] {
  const events: WorkingStateEvent[] = [];
  for (const entry of entries) {
    if (
      entry.type === "custom" &&
      entry.customType === WORKING_STATE_CUSTOM_TYPE &&
      isEvent(entry.data)
    ) {
      events.push(entry.data);
    }
  }
  return events;
}

export function restoreWorkingState(
  entries: readonly SessionEntryLike[],
): WorkingStateStore {
  return reduceWorkingState(workingStateEventsFromEntries(entries));
}

export function getWorkingStateSections(
  entries: readonly SessionEntryLike[],
): WorkingStateEntry[] {
  return restoreWorkingState(entries).list();
}
