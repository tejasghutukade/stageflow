import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "./helpers/fixturePaths.js";

const PI_AI_PACKAGE = path.join(
  REPO_ROOT,
  "node_modules",
  "@earendil-works",
  "pi-ai",
  "package.json",
);
const EXAMPLES = path.join(REPO_ROOT, "examples");
const EXTENSIONS = new Set([".yaml", ".yml", ".md"]);
const ANTHROPIC_MODEL = /(?<![A-Za-z0-9._/-])anthropic\/[A-Za-z0-9][A-Za-z0-9-]*/g;

function exampleFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...exampleFiles(full));
      continue;
    }
    if (EXTENSIONS.has(path.extname(entry))) out.push(full);
  }
  return out;
}

describe.skipIf(!existsSync(PI_AI_PACKAGE))("example Anthropic model ids", () => {
  it("match the pinned pi-ai catalog", async () => {
    const { builtinProviders } = await import("@earendil-works/pi-ai/providers/all");
    const provider = builtinProviders().find((item) => item.id === "anthropic");
    expect(provider).toBeDefined();
    const known = new Set(
      provider!.getModels().map((model) => `${provider!.id}/${model.id}`),
    );
    const found = new Set<string>();
    for (const file of exampleFiles(EXAMPLES)) {
      for (const match of readFileSync(file, "utf8").matchAll(ANTHROPIC_MODEL)) {
        found.add(match[0]);
      }
    }
    expect([...found].filter((id) => !known.has(id)).sort()).toEqual([]);
    expect(found.size).toBeGreaterThan(0);
  });
});
