import { afterEach, describe, expect, it } from "vitest";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse, stringify } from "yaml";
import { loadPublicationRegistry } from "../src/a2a/registry.js";
import { runA2aCommand } from "../src/cli/a2aCommand.js";

const fixture = path.resolve("tests/fixtures/a2a");
const env = { PROCUREMENT_TOKEN: "p".repeat(40), OTHER_TOKEN: "o".repeat(40) };
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function copyFixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "sf-a2a-registry-"));
  roots.push(root);
  await cp(fixture, root, { recursive: true });
  return root;
}

describe("A2A publication registry", () => {
  it("filters publications, authenticates tokens, and never exposes credentials in CLI output", async () => {
    const config = path.join(fixture, "a2a.yaml");
    const registry = await loadPublicationRegistry(config, env);
    expect(registry.authenticate(`Bearer ${env.PROCUREMENT_TOKEN}`)).toBe("procurement");
    expect(registry.authenticate("Bearer wrong")).toBeUndefined();
    expect(registry.list("other")).toEqual([]);
    expect(registry.get("procurement", "supplier_assessment")?.inputSchema.required).toEqual(["supplier"]);
    const lines: string[] = [];
    expect(await runA2aCommand(["list", "--config", config], { cwd: fixture, env, log: (line) => lines.push(line) })).toBe(0);
    expect(lines.join()).toContain("supplier_assessment");
    expect(lines.join()).not.toContain(env.PROCUREMENT_TOKEN);
  });

  it("detects pipeline drift and returns defensive copies", async () => {
    const root = await copyFixture();
    const registry = await loadPublicationRegistry(path.join(root, "a2a.yaml"), env);
    registry.list("procurement")[0].allowed_callers.push("other");
    expect(registry.list("other")).toEqual([]);
    await registry.assertUnchanged("procurement", "supplier_assessment");
    const pipeline = path.join(root, "supplier.pipeline.yaml");
    await writeFile(pipeline, (await readFile(pipeline, "utf8")).replace("Clarify the", "Carefully clarify the"));
    await expect(registry.assertUnchanged("procurement", "supplier_assessment")).rejects.toThrow("Publication changed");
  });

  it.each(["duplicate", "unknown-caller", "approval", "artifact", "input", "url"])("rejects invalid publication: %s", async (kind) => {
    const root = await copyFixture();
    const configPath = path.join(root, "a2a.yaml");
    const config = parse(await readFile(configPath, "utf8"));
    if (kind === "duplicate") config.publications.push(config.publications[0]);
    if (kind === "unknown-caller") config.publications[0].allowed_callers = ["unknown"];
    if (kind === "approval") {
      const pipeline = path.join(root, "supplier.pipeline.yaml");
      await writeFile(pipeline, (await readFile(pipeline, "utf8")).replace("[free_text]", "[confirm]"));
    }
    if (kind === "artifact") config.publications[0].results.artifacts = ["secret.txt"];
    if (kind === "input") await writeFile(path.join(root, "supplier.schema.json"), '{"type":"object"}');
    if (kind === "url") config.public_url = "http://public.example";
    await writeFile(configPath, stringify(config));
    await expect(loadPublicationRegistry(configPath, env)).rejects.toThrow();
  });

  it("rejects missing and shared credentials without printing their values", async () => {
    const config = path.join(fixture, "a2a.yaml");
    await expect(loadPublicationRegistry(config, {})).rejects.toThrow("requires a token");
    await expect(loadPublicationRegistry(config, { ...env, OTHER_TOKEN: env.PROCUREMENT_TOKEN })).rejects.toThrow("Duplicate caller credential");
  });
});
