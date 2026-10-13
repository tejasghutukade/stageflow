export type DiffLine = {
  kind: "context" | "added" | "removed";
  oldLine?: number;
  newLine?: number;
  text: string;
};

export type DiffSkipRow = { kind: "skip"; count: number };

export type DiffDisplayRow = DiffLine | DiffSkipRow;

export type DiffTotals = { added: number; removed: number };

const LCS_CELL_LIMIT = 4_000_000;

export function splitLines(text: string | undefined | null): string[] {
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function middleDiff(
  a: readonly string[],
  b: readonly string[],
): Array<"context" | "added" | "removed"> {
  const n = a.length;
  const m = b.length;
  if (n === 0) return b.map(() => "added");
  if (m === 0) return a.map(() => "removed");
  if (n * m > LCS_CELL_LIMIT) {
    return [...a.map(() => "removed" as const), ...b.map(() => "added" as const)];
  }
  const width = m + 1;
  const dp = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i * width + j] =
        a[i] === b[j]
          ? dp[(i + 1) * width + j + 1]! + 1
          : Math.max(dp[(i + 1) * width + j]!, dp[i * width + j + 1]!);
    }
  }
  const ops: Array<"context" | "added" | "removed"> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push("context");
      i += 1;
      j += 1;
    } else if (dp[(i + 1) * width + j]! >= dp[i * width + j + 1]!) {
      ops.push("removed");
      i += 1;
    } else {
      ops.push("added");
      j += 1;
    }
  }
  while (i < n) {
    ops.push("removed");
    i += 1;
  }
  while (j < m) {
    ops.push("added");
    j += 1;
  }
  return ops;
}

export function diffLines(before: string | undefined, after: string | undefined): DiffLine[] {
  const a = splitLines(before);
  const b = splitLines(after);
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const ops: Array<"context" | "added" | "removed"> = [
    ...a.slice(0, prefix).map(() => "context" as const),
    ...middleDiff(a.slice(prefix, a.length - suffix), b.slice(prefix, b.length - suffix)),
    ...a.slice(a.length - suffix).map(() => "context" as const),
  ];

  const out: DiffLine[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  for (const op of ops) {
    if (op === "context") {
      out.push({
        kind: "context",
        oldLine: oldIndex + 1,
        newLine: newIndex + 1,
        text: b[newIndex]!,
      });
      oldIndex += 1;
      newIndex += 1;
    } else if (op === "removed") {
      out.push({ kind: "removed", oldLine: oldIndex + 1, text: a[oldIndex]! });
      oldIndex += 1;
    } else {
      out.push({ kind: "added", newLine: newIndex + 1, text: b[newIndex]! });
      newIndex += 1;
    }
  }
  return out;
}

export function diffTotals(lines: readonly DiffLine[]): DiffTotals {
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.kind === "added") added += 1;
    else if (line.kind === "removed") removed += 1;
  }
  return { added, removed };
}

export function collapseContext(
  lines: readonly DiffLine[],
  radius = 3,
): DiffDisplayRow[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  let anyChange = false;
  lines.forEach((line, index) => {
    if (line.kind === "context") return;
    anyChange = true;
    const from = Math.max(0, index - radius);
    const to = Math.min(lines.length - 1, index + radius);
    for (let k = from; k <= to; k += 1) keep[k] = true;
  });
  if (!anyChange) return [];

  const rows: DiffDisplayRow[] = [];
  let skipped = 0;
  lines.forEach((line, index) => {
    if (keep[index]) {
      if (skipped > 0) {
        rows.push({ kind: "skip", count: skipped });
        skipped = 0;
      }
      rows.push(line);
    } else {
      skipped += 1;
    }
  });
  if (skipped > 0) rows.push({ kind: "skip", count: skipped });
  return rows;
}

export type ArtifactDiff = {
  lines: DiffLine[];
  rows: DiffDisplayRow[];
  totals: DiffTotals;
};

export function artifactDiff(
  artifact: { before?: string; after?: string },
  radius = 3,
): ArtifactDiff {
  const lines = diffLines(artifact.before, artifact.after);
  return {
    lines,
    rows: collapseContext(lines, radius),
    totals: diffTotals(lines),
  };
}

export function sumTotals(totals: readonly DiffTotals[]): DiffTotals {
  return totals.reduce(
    (acc, next) => ({
      added: acc.added + next.added,
      removed: acc.removed + next.removed,
    }),
    { added: 0, removed: 0 },
  );
}
