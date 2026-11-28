import type { ArtifactLiveBinding, ArtifactSnapshot } from "../../../api/artifacts";
import { canonicalJson } from "./toolProvider";

export type LiveDataAssessment = {
  state: "ok" | "empty" | "mismatch";
  missing: string[];
};

type Statement = { id: string; body: string };

function statements(program: string): Statement[] {
  const found: Statement[] = [];
  for (const line of program.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const id = trimmed.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(id)) continue;
    found.push({ id, body: trimmed.slice(eq + 1).trim() });
  }
  return found;
}

type Root = { snapshot: unknown; prefix: string[] };

function walk(value: unknown, segments: string[]): "ok" | "empty" | "missing" {
  let current = value;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    if (Array.isArray(current)) {
      if (current.length === 0) return "empty";
      const rest = segments.slice(index);
      let missing = false;
      let ok = false;
      let empty = false;
      for (const item of current) {
        const result = walk(item, rest);
        if (result === "ok") ok = true;
        else if (result === "empty") empty = true;
        else missing = true;
      }
      if (missing) return "missing";
      if (ok) return "ok";
      if (empty) return "empty";
      return "empty";
    }
    if (current === null || typeof current !== "object") return "missing";
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return "missing";
    current = (current as Record<string, unknown>)[segment];
  }
  if (Array.isArray(current) && current.length === 0) return "empty";
  return "ok";
}

export function assessLiveProgramData(
  program: string,
  bindings: readonly ArtifactLiveBinding[],
  snapshots: readonly ArtifactSnapshot[],
): LiveDataAssessment {
  const parsed = statements(program);
  const queryTools = new Map<string, string>();
  for (const statement of parsed) {
    const match = /^Query\(\s*"([^"]+)"/.exec(statement.body);
    if (match) queryTools.set(statement.id, match[1]!);
  }
  const roots = new Map<string, Root>();
  for (const [name, tool] of queryTools) {
    const binding = bindings.find((item) => item.function === tool);
    const snapshot = binding ? snapshots.find((item) => item.binding_id === binding.id) : undefined;
    if (snapshot) roots.set(name, { snapshot: snapshot.value, prefix: [] });
  }
  for (const statement of parsed) {
    const alias = /^([A-Za-z_][A-Za-z0-9_]*)((?:\.[A-Za-z_][A-Za-z0-9_]*)+)$/.exec(statement.body);
    if (!alias) continue;
    const base = roots.get(alias[1]!);
    if (!base) continue;
    const extra = alias[2]!.split(".").filter((part) => part.length > 0);
    roots.set(statement.id, { snapshot: base.snapshot, prefix: [...base.prefix, ...extra] });
  }
  const missing: string[] = [];
  let sawEmpty = false;
  let sawOk = false;
  const field = /(?:^|[^A-Za-z0-9_])([A-Za-z_][A-Za-z0-9_]*)((?:\.[A-Za-z_][A-Za-z0-9_]*)+)/g;
  const seen = new Set<string>();
  for (const statement of parsed) {
    field.lastIndex = 0;
    let match = field.exec(statement.body);
    while (match) {
      const root = roots.get(match[1]!);
      if (root) {
        const extra = match[2]!.split(".").filter((part) => part.length > 0);
        const path = [...root.prefix, ...extra];
        const key = `${match[1]}.${path.join(".")}`;
        if (!seen.has(key)) {
          seen.add(key);
          const result = walk(root.snapshot, path);
          const label = `${match[1]}.${path.join(".")}`;
          if (result === "missing") missing.push(label);
          else if (result === "empty") sawEmpty = true;
          else sawOk = true;
        }
      }
      match = field.exec(statement.body);
    }
  }
  if (missing.length > 0) return { state: "mismatch", missing };
  if (sawEmpty && !sawOk) return { state: "empty", missing: [] };
  return { state: "ok", missing: [] };
}

export function programQueryTools(program: string): string[] {
  const tools: string[] = [];
  for (const statement of statements(program)) {
    const match = /^Query\(\s*"([^"]+)"/.exec(statement.body);
    if (match) tools.push(match[1]!);
  }
  return tools;
}

export function programHasInputs(program: string): boolean {
  return /(^|[^\w])(Select|Input)\s*\(/.test(program);
}

export function defaultBindingsMissingSnapshot(
  program: string,
  bindings: readonly ArtifactLiveBinding[],
  snapshots: readonly ArtifactSnapshot[],
): boolean {
  const tools = new Set(programQueryTools(program));
  if (tools.size === 0) return false;
  for (const binding of bindings) {
    if (!tools.has(binding.function)) continue;
    if (!snapshots.some((item) => item.binding_id === binding.id)) return true;
  }
  return false;
}

export function liveDefaultValueCanon(
  bindings: readonly ArtifactLiveBinding[],
  snapshots: readonly ArtifactSnapshot[],
): string {
  return bindings
    .map((binding) => {
      const snapshot = snapshots.find((item) => item.binding_id === binding.id);
      return `${binding.id}=${snapshot ? canonicalJson(snapshot.value) : ""}`;
    })
    .join("\n");
}

export function liveDefaultSnapshotKey(
  bindings: readonly ArtifactLiveBinding[],
  snapshots: readonly ArtifactSnapshot[],
): string {
  return fingerprint(liveDefaultValueCanon(bindings, snapshots));
}

function fingerprint(text: string): string {
  let fnv = 2166136261;
  let djb = 5381;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    fnv ^= code;
    fnv = Math.imul(fnv, 16777619);
    djb = Math.imul(djb, 33) ^ code;
  }
  return `${text.length.toString(16)}-${(fnv >>> 0).toString(16)}-${(djb >>> 0).toString(16)}`;
}

function declaredStateVariables(program: string): Set<string> {
  const names = new Set<string>();
  for (const line of program.split("\n")) {
    const match = /^\s*(\$[A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (match?.[1]) names.add(match[1]);
  }
  return names;
}

function selectValueOptions(program: string): Map<string, Set<string>> {
  const literals = new Set<string>();
  for (const match of program.matchAll(/SelectItem\(\s*"((?:\\.|[^"\\])*)"/g)) {
    literals.add(match[1]!.replace(/\\"/g, '"').replace(/\\\\/g, "\\"));
  }
  const bound = new Map<string, Set<string>>();
  if (literals.size === 0) return bound;
  const select = /Select\(\s*"[^"]*"\s*,\s*\[[^\]]*]\s*,\s*(?:"[^"]*"|null)\s*,\s*(?:null|\[[^\]]*]|"(?:\\.|[^"\\])*")\s*,\s*(\$[A-Za-z_][A-Za-z0-9_]*)/g;
  for (const match of program.matchAll(select)) {
    if (match[1]) bound.set(match[1], literals);
  }
  return bound;
}

function jsonSafe(value: unknown): boolean {
  if (value === null) return true;
  const kind = typeof value;
  if (kind === "string" || kind === "boolean") return true;
  if (kind === "number") return Number.isFinite(value);
  if (kind !== "object") return false;
  try {
    JSON.stringify(value);
    return true;
  } catch {
    return false;
  }
}

export function sanitizeLiveViewerState(
  state: Record<string, unknown> | undefined,
  program: string,
): Record<string, unknown> | undefined {
  if (!state) return undefined;
  const declared = declaredStateVariables(program);
  const options = selectValueOptions(program);
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(state)) {
    if (!key.startsWith("$") || !declared.has(key)) continue;
    if (!jsonSafe(value)) continue;
    const allowed = options.get(key);
    if (allowed && (typeof value !== "string" || !allowed.has(value))) continue;
    next[key] = value;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}
