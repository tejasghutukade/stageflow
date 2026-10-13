import { YAMLParseError } from "yaml";

export function yamlParsePosition(err: unknown): { line: number; column: number } | undefined {
  if (!(err instanceof YAMLParseError)) return undefined;
  const pos = err.linePos?.[0];
  if (!pos) return undefined;
  return { line: pos.line, column: pos.col };
}
