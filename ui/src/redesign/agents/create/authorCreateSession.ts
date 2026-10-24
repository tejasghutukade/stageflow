import type { AgentDefinition } from "../../../api/agents";

const SECTION_KEYS: Record<string, Array<keyof AgentDefinition>> = {
  Identity: ["id", "name", "description", "greeting"],
  Instructions: ["instructions", "project_context"],
  Model: ["model"],
  Tools: ["tools"],
  Approvals: ["approvals"],
  "Sub-agents": ["sub_agents", "sub_agent_depth"],
  Guardrails: ["guardrails", "evals"],
  Capture: ["observability"],
  Channels: ["channel", "schedule"],
  Limits: ["limits"],
};

/**
 * Sections listed on the turn replace those fields. Every other field stays
 * as the form has it, including keystrokes the turn never saw. An empty
 * summary means the turn did not change the draft.
 */
export function mergeAuthorTurnIntoForm(
  form: AgentDefinition,
  returned: Record<string, unknown>,
  summaryLines: ReadonlyArray<{ label: string; value?: string }>,
  sent?: Record<string, unknown>,
): AgentDefinition {
  if (summaryLines.length === 0) return form;
  const next = { ...form };
  let applied = false;
  for (const line of summaryLines) {
    const keys = SECTION_KEYS[line.label];
    if (!keys) continue;
    for (const key of keys) {
      if (!Object.prototype.hasOwnProperty.call(returned, key)) continue;
      const returnedValue = returned[key];
      const sentValue = sent?.[key];
      if (sent && sameValue(sentValue, returnedValue)) continue;
      applyReturnedKey(next, form, key, returnedValue, sent ? sentValue : undefined, Boolean(sent));
      applied = true;
    }
  }
  return applied ? next : form;
}

function applyReturnedKey(
  next: AgentDefinition,
  form: AgentDefinition,
  key: keyof AgentDefinition,
  value: unknown,
  sentValue: unknown,
  hasSent: boolean,
) {
  const record = next as unknown as Record<string, unknown>;
  if (value === null || value === undefined) {
    delete record[key];
    return;
  }
  const current = form[key];
  if (hasSent && isPlain(value) && isPlain(sentValue) && isPlain(current)) {
    record[key] = mergeObject(current, sentValue, value);
    return;
  }
  if (!hasSent && isPlain(value) && isPlain(current)) {
    record[key] = { ...current, ...value };
    return;
  }
  record[key] = value;
}

function mergeObject(
  form: Record<string, unknown>,
  sent: Record<string, unknown>,
  returned: Record<string, unknown>,
): Record<string, unknown> {
  const keys = new Set([...Object.keys(form), ...Object.keys(sent), ...Object.keys(returned)]);
  const next: Record<string, unknown> = { ...form };
  for (const key of keys) {
    const returnedHas = Object.prototype.hasOwnProperty.call(returned, key);
    const sentHas = Object.prototype.hasOwnProperty.call(sent, key);
    if (sentHas && !returnedHas) {
      delete next[key];
      continue;
    }
    if (!returnedHas) continue;
    if (sameValue(sent[key], returned[key])) continue;
    const formChild = form[key];
    const sentChild = sent[key];
    const returnedChild = returned[key];
    next[key] = isPlain(formChild) && isPlain(sentChild) && isPlain(returnedChild)
      ? mergeObject(formChild, sentChild, returnedChild)
      : returnedChild;
  }
  return next;
}

function isPlain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export type AuthorCreateClaim = {
  note(draft: AgentDefinition): void;
  adopt(sessionId: string): void;
  ensure(started: AgentDefinition, existingId?: string): Promise<string>;
  writeIfCurrent(captured: AgentDefinition): Promise<void>;
};

export function createAuthorCreateClaim(deps: {
  create: (draft: AgentDefinition) => Promise<string>;
  save: (sessionId: string, draft: AgentDefinition) => Promise<unknown>;
}): AuthorCreateClaim {
  let current: AgentDefinition | undefined;
  let claimedId: string | undefined;
  let mintedId: string | undefined;
  let inflight: Promise<string> | null = null;

  function note(draft: AgentDefinition) {
    current = draft;
  }

  return {
    note,
    adopt(sessionId: string) {
      claimedId = sessionId;
    },
    ensure(started: AgentDefinition, existingId?: string) {
      note(started);
      if (claimedId) return Promise.resolve(claimedId);
      if (existingId) {
        claimedId = existingId;
        return Promise.resolve(existingId);
      }
      if (!inflight) {
        const captured = started;
        let resolve!: (id: string) => void;
        let reject!: (error: unknown) => void;
        // Stored before create() so a second caller waits on this promise.
        inflight = new Promise<string>((res, rej) => {
          resolve = res;
          reject = rej;
        });
        void (async () => {
          try {
            const id = mintedId ?? (await deps.create(captured));
            mintedId = id;
            await deps.save(id, current ?? captured);
            claimedId = id;
            resolve(id);
          } catch (error) {
            reject(error instanceof Error ? error : new Error("Could not create the author session"));
          } finally {
            inflight = null;
          }
        })();
      }
      return inflight;
    },
    async writeIfCurrent(captured: AgentDefinition) {
      if (current !== captured || !claimedId) return;
      await deps.save(claimedId, captured);
    },
  };
}
