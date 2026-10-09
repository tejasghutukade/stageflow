export type YamlTokenKind = "plain" | "key" | "string" | "comment";

export type YamlToken = {
  kind: YamlTokenKind;
  text: string;
};

function pushToken(tokens: YamlToken[], kind: YamlTokenKind, text: string) {
  if (!text) return;
  const prev = tokens[tokens.length - 1];
  if (prev && prev.kind === kind) prev.text += text;
  else tokens.push({ kind, text });
}

export function highlightYamlLine(line: string): YamlToken[] {
  const tokens: YamlToken[] = [];
  let i = 0;

  while (i < line.length && (line[i] === " " || line[i] === "\t")) {
    pushToken(tokens, "plain", line[i]!);
    i += 1;
  }

  if (line[i] === "-" && (line[i + 1] === " " || line[i + 1] === undefined)) {
    pushToken(tokens, "plain", "-");
    i += 1;
    while (i < line.length && line[i] === " ") {
      pushToken(tokens, "plain", line[i]!);
      i += 1;
    }
  }

  if (line[i] === "#") {
    pushToken(tokens, "comment", line.slice(i));
    return tokens;
  }

  const keyMatch = /^([A-Za-z_][A-Za-z0-9_-]*)(:)/.exec(line.slice(i));
  if (keyMatch) {
    pushToken(tokens, "key", keyMatch[1]!);
    pushToken(tokens, "plain", ":");
    i += keyMatch[0].length;
  }

  while (i < line.length) {
    const ch = line[i]!;
    if (ch === '"' || ch === "'") {
      const quote = ch;
      let j = i + 1;
      while (j < line.length) {
        if (quote === '"' && line[j] === "\\") {
          j += 2;
          continue;
        }
        if (line[j] === quote) {
          j += 1;
          break;
        }
        j += 1;
      }
      pushToken(tokens, "string", line.slice(i, j));
      i = j;
      continue;
    }
    if (ch === "#" && (i === 0 || line[i - 1] === " ")) {
      pushToken(tokens, "comment", line.slice(i));
      break;
    }
    pushToken(tokens, "plain", ch);
    i += 1;
  }

  return tokens;
}

function leadingIndent(line: string): number {
  let count = 0;
  while (count < line.length && (line[count] === " " || line[count] === "\t")) count += 1;
  return count;
}

function isBlockScalarHeader(line: string): boolean {
  const code = line.replace(/(^|\s+)#.*$/, "");
  return /:\s*[|>][+-]?\s*$/.test(code);
}

export function highlightYaml(source: string): YamlToken[][] {
  const raw = source.split("\n");
  if (raw.length > 0 && raw[raw.length - 1] === "") raw.pop();
  const lines: YamlToken[][] = [];
  let blockMin: number | null = null;
  for (const line of raw) {
    if (blockMin !== null) {
      if (line.trim() === "" || leadingIndent(line) >= blockMin) {
        lines.push(line.length > 0 ? [{ kind: "string", text: line }] : []);
        continue;
      }
      blockMin = null;
    }
    lines.push(highlightYamlLine(line));
    if (isBlockScalarHeader(line)) blockMin = leadingIndent(line) + 1;
  }
  return lines;
}
