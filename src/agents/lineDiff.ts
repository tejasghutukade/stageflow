export type DiffLine = { kind: "same" | "added" | "removed"; text: string; before?: number; after?: number };

/**
 * Line diff by longest common subsequence. Agent YAML files are small (tens to
 * low hundreds of lines), so the O(n·m) table is fine and keeps this
 * dependency-free.
 */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = splitLines(before);
  const b = splitLines(after);
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i]!, before: i + 1, after: j + 1 });
      i += 1;
      j += 1;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push({ kind: "removed", text: a[i]!, before: i + 1 });
      i += 1;
    } else {
      out.push({ kind: "added", text: b[j]!, after: j + 1 });
      j += 1;
    }
  }
  for (; i < a.length; i += 1) out.push({ kind: "removed", text: a[i]!, before: i + 1 });
  for (; j < b.length; j += 1) out.push({ kind: "added", text: b[j]!, after: j + 1 });
  return out;
}

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}
