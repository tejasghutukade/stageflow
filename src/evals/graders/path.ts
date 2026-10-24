export type PathNode = { found: boolean; value?: unknown };

export type PathResult = {
  nodes: PathNode[];
  resolved: boolean;
  wildcard: boolean;
  emptyWildcard: boolean;
};

type Segment = { kind: "key"; key: string } | { kind: "index"; index: number } | { kind: "all" };

export function parsePath(path: string): Segment[] | undefined {
  const segments: Segment[] = [];
  for (const part of path.split(".")) {
    const m = /^([^[\]]*)((?:\[(?:\d+|\*)\])*)$/.exec(part);
    if (!m) return undefined;
    const [, key, brackets] = m;
    if (key === "" && brackets === "") return undefined;
    if (key !== "") segments.push({ kind: "key", key });
    for (const b of brackets.matchAll(/\[(\d+|\*)\]/g)) {
      segments.push(b[1] === "*" ? { kind: "all" } : { kind: "index", index: Number(b[1]) });
    }
  }
  return segments.length > 0 ? segments : undefined;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function evaluatePath(root: unknown, path: string): PathResult {
  const segments = parsePath(path);
  if (!segments) {
    return { nodes: [{ found: false }], resolved: false, wildcard: false, emptyWildcard: false };
  }
  const wildcard = segments.some((s) => s.kind === "all");
  let sawEmpty = false;
  let nodes: PathNode[] = [{ found: true, value: root }];
  for (const seg of segments) {
    const next: PathNode[] = [];
    for (const node of nodes) {
      if (!node.found) {
        next.push(node);
        continue;
      }
      const v = node.value;
      if (seg.kind === "key") {
        if (isRecord(v) && Object.prototype.hasOwnProperty.call(v, seg.key)) {
          next.push({ found: true, value: v[seg.key] });
        } else next.push({ found: false });
      } else if (seg.kind === "index") {
        if (Array.isArray(v) && seg.index < v.length) next.push({ found: true, value: v[seg.index] });
        else next.push({ found: false });
      } else if (Array.isArray(v)) {
        if (v.length === 0) sawEmpty = true;
        for (const item of v) next.push({ found: true, value: item });
      } else next.push({ found: false });
    }
    nodes = next;
  }
  const resolved = nodes.length > 0 && nodes.every((n) => n.found);
  return { nodes, resolved, wildcard, emptyWildcard: sawEmpty && nodes.length === 0 };
}

export function resolveValue(root: unknown, path: string): { found: boolean; value?: unknown } {
  const r = evaluatePath(root, path);
  if (!r.wildcard) {
    const n = r.nodes[0];
    return n?.found ? { found: true, value: n.value } : { found: false };
  }
  if (r.emptyWildcard) return { found: true, value: [] };
  if (!r.resolved) return { found: false };
  return { found: true, value: r.nodes.map((n) => n.value) };
}
