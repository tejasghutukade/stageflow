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
const DOCS = path.join(REPO_ROOT, "docs");
const EXTENSIONS = new Set([".yaml", ".yml", ".md"]);
const ANTHROPIC_MODEL = /(?<![A-Za-z0-9._/-])anthropic\/[A-Za-z0-9][A-Za-z0-9-]*/g;
const OPENROUTER_ANTHROPIC = /(?<![A-Za-z0-9._/-])openrouter\/anthropic\/[A-Za-z0-9][A-Za-z0-9-]*/g;

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

const piAiPresent = existsSync(PI_AI_PACKAGE);

describe.skipIf(!piAiPresent && !process.env.CI)("example Anthropic model ids", () => {
  it("match the pinned pi-ai catalog", async () => {
    expect(piAiPresent, "@earendil-works/pi-ai is required when CI is set").toBe(true);
    const { builtinProviders } = await import("@earendil-works/pi-ai/providers/all");
    const providers = builtinProviders();
    const anthropic = providers.find((item) => item.id === "anthropic");
    const openrouter = providers.find((item) => item.id === "openrouter");
    expect(anthropic).toBeDefined();
    expect(openrouter).toBeDefined();
    const known = new Set(
      anthropic!.getModels().map((model) => `${anthropic!.id}/${model.id}`),
    );
    const openrouterKnown = new Set(
      openrouter!.getModels().map((model) => `openrouter/${model.id}`),
    );
    const found = new Set<string>();
    const openrouterFound = new Set<string>();
    const files = [
      ...exampleFiles(EXAMPLES),
      ...exampleFiles(DOCS),
      path.join(REPO_ROOT, "README.md"),
      path.join(REPO_ROOT, "src", "cli", "initTemplates.ts"),
    ];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(ANTHROPIC_MODEL)) found.add(match[0]);
      for (const match of text.matchAll(OPENROUTER_ANTHROPIC)) openrouterFound.add(match[0]);
    }
    expect([...found].filter((id) => !known.has(id)).sort()).toEqual([]);
    expect([...openrouterFound].filter((id) => !openrouterKnown.has(id)).sort()).toEqual([]);
    expect(found.size).toBeGreaterThan(0);
  });
});
