/** What an agent id looks like. Lives here, not in the loader, so the loader can import the reserved list without a cycle. */
export const AGENT_ID_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

/** Ids that collide with fixed `/api/agents/<word>` routes. The single list: the loader and the generator both read it. */
export const RESERVED_AGENT_IDS: ReadonlySet<string> = new Set(["sessions", "approvals", "new"]);

export function isReservedAgentId(id: string): boolean {
  return RESERVED_AGENT_IDS.has(id);
}

export function slugAgentId(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^[^a-z]+/, "")
    .slice(0, 56);
  return AGENT_ID_PATTERN.test(slug) ? slug : "";
}

/** An id from the agent's name, made unique with a numeric suffix. Names with no usable letters become `agent`. */
export async function generateAgentId(name: string, isTaken: (id: string) => Promise<boolean>): Promise<string> {
  const base = slugAgentId(name) || "agent";
  for (let attempt = 1; attempt < 1000; attempt += 1) {
    const candidate = attempt === 1 ? base : `${base}_${attempt}`;
    if (!RESERVED_AGENT_IDS.has(candidate) && !(await isTaken(candidate))) return candidate;
  }
  throw new Error("Could not generate a unique agent id");
}
