import { existsSync, readFileSync } from "node:fs";

export function readAuthKey(authPath: string, provider: string): string | undefined {
  try {
    if (!existsSync(authPath)) return undefined;
    const parsed: unknown = JSON.parse(readFileSync(authPath, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const entry = (parsed as Record<string, unknown>)[provider];
    if (typeof entry !== "object" || entry === null) return undefined;
    const { type, key } = entry as { type?: unknown; key?: unknown };
    if (type !== "api_key" || typeof key !== "string" || key.length === 0 || key.startsWith("!")) {
      return undefined;
    }
    return key;
  } catch {
    return undefined;
  }
}
