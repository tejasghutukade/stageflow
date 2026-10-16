import { AGENT_ID_PATTERN } from "../config/loadAgent.js";

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
    if (!(await isTaken(candidate))) return candidate;
  }
  throw new Error("Could not generate a unique agent id");
}
