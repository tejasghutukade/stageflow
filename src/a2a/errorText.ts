import { realpathSync } from "node:fs";

function variants(prefix: string): string[] {
  const trimmed = prefix.replace(/[\\/]+$/, "");
  try {
    return [trimmed, realpathSync(trimmed)];
  } catch {
    return [trimmed];
  }
}

/**
 * Error text the A2A API or status may show: paths under a known folder become relative to it, and any
 * other absolute path is cut to its last segment, so no server filesystem layout leaves the Host.
 */
export function scrubA2aPaths(message: string, prefixes: readonly (string | undefined)[]): string {
  const known = [...new Set(prefixes.flatMap((prefix) => (prefix ? variants(prefix) : [])))]
    .filter((prefix) => prefix.length > 1)
    .sort((a, b) => b.length - a.length);
  let out = message;
  for (const prefix of known) out = out.split(prefix + "/").join("").split(prefix + "\\").join("").split(prefix).join(".");
  return out.replace(/(?<![\w:/.\\-])(?:[A-Za-z]:)?(?:[\\/][^\s'"`\\/]+)+[\\/]([^\s'"`\\/]+)/g, "$1");
}
