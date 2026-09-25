import { afterEach, describe, expect, it } from "vitest";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse, stringify } from "yaml";
import { loadPublicationRegistry } from "../src/a2a/registry.js";
import { runA2aCommand } from "../src/cli/a2aCommand.js";
import { resolveA2aConfigPath } from "../src/a2a/configDiscovery.js";

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

  it("round-trips optional publication repository/ref (U7)", async () => {
    const root = await copyFixture();
    const configPath = path.join(root, "a2a.yaml");
    const config = parse(await readFile(configPath, "utf8"));
    config.publications[0].repository = "acme/api";
    config.publications[0].ref = "main";
    await writeFile(configPath, stringify(config));
    const registry = await loadPublicationRegistry(configPath, env);
    const pub = registry.get("procurement", "supplier_assessment");
    expect(pub?.repository).toBe("acme/api");
    expect(pub?.ref).toBe("main");

    delete config.publications[0].ref;
    await writeFile(configPath, stringify(config));
    await expect(loadPublicationRegistry(configPath, env)).rejects.toThrow(/repository requires ref/i);
  });
});

describe("A2A config auto-discovery", () => {
  it("prefers STAGEFLOW_A2A_CONFIG, then <projectRoot>/a2a.yaml, then undefined", async () => {
    const root = await copyFixture();
    expect(resolveA2aConfigPath(root, {})).toBe(path.join(root, "a2a.yaml"));
    expect(resolveA2aConfigPath(root, { STAGEFLOW_A2A_CONFIG: "/elsewhere/a2a.yaml" })).toBe("/elsewhere/a2a.yaml");
    const empty = await mkdtemp(path.join(tmpdir(), "sf-a2a-empty-"));
    roots.push(empty);
    expect(resolveA2aConfigPath(empty, {})).toBeUndefined();
  });

  it("validates and lists via auto-discovery when --config is omitted", async () => {
    const root = await copyFixture();
    const lines: string[] = [];
    expect(await runA2aCommand(["validate"], { cwd: root, projectRoot: root, env, log: (line) => lines.push(line) })).toBe(0);
    expect(lines.join()).toContain("supplier_assessment");
  });

  it("reports a clear error when no config is found anywhere", async () => {
    const empty = await mkdtemp(path.join(tmpdir(), "sf-a2a-empty-"));
    roots.push(empty);
    const errors: string[] = [];
    expect(await runA2aCommand(["validate"], { cwd: empty, projectRoot: empty, env: {}, error: (line) => errors.push(line) })).toBe(1);
    expect(errors.join()).toContain("No A2A configuration found");
  });
});

describe("sf a2a add-caller", () => {
  it("creates a fresh config when none exists, and flags it as incomplete", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-a2a-addcaller-"));
    roots.push(root);
    const lines: string[] = [];
    const code = await runA2aCommand(["add-caller", "acme"], { cwd: root, projectRoot: root, log: (line) => lines.push(line) });
    expect(code).toBe(0);
    const written = parse(await readFile(path.join(root, "a2a.yaml"), "utf8"));
    expect(written.callers).toEqual([{ id: "acme", token_env: "ACME_TOKEN" }]);
    expect(lines.join("\n")).toMatch(/export ACME_TOKEN=[0-9a-f]{48}/);
    expect(lines.join("\n")).toContain("no publications yet");
  });

  it("appends to an existing config without disturbing publications, and rejects a duplicate id", async () => {
    const root = await copyFixture();
    const code = await runA2aCommand(["add-caller", "acme", "--token-env", "ACME_SECRET"], { cwd: root, projectRoot: root, log: () => undefined });
    expect(code).toBe(0);
    const written = parse(await readFile(path.join(root, "a2a.yaml"), "utf8"));
    expect(written.callers.map((c: { id: string }) => c.id)).toEqual(["procurement", "other", "acme"]);
    expect(written.publications).toHaveLength(1);

    const errors: string[] = [];
    const dup = await runA2aCommand(["add-caller", "acme"], { cwd: root, projectRoot: root, error: (line) => errors.push(line) });
    expect(dup).toBe(1);
    expect(errors.join()).toContain("already exists");
  });
});
