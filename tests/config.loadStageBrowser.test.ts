import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadPipeline } from "../src/config/loadPipeline.js";
import { FIXTURES_ROOT, SINGLE_PIPELINE } from "./helpers/fixturePaths.js";

const BROWSER_DIR = path.join(FIXTURES_ROOT, "browser");

async function loadInlineBrowser(browserLines: string[]) {
  const dir = await mkdtemp(path.join(tmpdir(), "sf-browser-"));
  const file = path.join(dir, "p.pipeline.yaml");
  await writeFile(
    file,
    [
      "id: p",
      "stages:",
      "  - id: worker",
      "    system_prompt: x",
      "    model: anthropic/claude-sonnet-4-5",
      "    io:",
      "      input:",
      "        schema:",
      "          type: object",
      "      output:",
      "        schema:",
      "          type: object",
      "    browser:",
      ...browserLines.map((line) => `      ${line}`),
      "",
    ].join("\n"),
  );
  return loadPipeline(file);
}

describe("stage browser field", () => {
  it("loads browser from an external stage file and adds the agent-browser requirement", async () => {
    const loaded = await loadPipeline(path.join(BROWSER_DIR, "uses-file.pipeline.yaml"));
    const stage = loaded.stages[0];
    expect(stage?.browser).toEqual({
      profile: "file-profile",
      headed: false,
      allow_domains: ["file.example.com"],
    });
    expect(stage?.requires).toEqual([{ tool: "agent-browser" }]);
  });

  it("lets the pipeline entry override the stage file value", async () => {
    const loaded = await loadPipeline(
      path.join(BROWSER_DIR, "uses-override.pipeline.yaml"),
    );
    expect(loaded.stages[0]?.browser).toEqual({
      profile: "entry-profile",
      allow_domains: ["example.com", "*.example.com"],
      check: {
        url: "https://example.com/feed",
        logged_in_url: "https://example.com/feed*",
        logged_out_url: [
          "https://example.com/login*",
          "https://example.com/checkpoint*",
        ],
      },
    });
  });

  it("merges with an explicit requires entry without conflict", async () => {
    const loaded = await loadPipeline(
      path.join(BROWSER_DIR, "inline-explicit-requires.pipeline.yaml"),
    );
    const stage = loaded.stages[0];
    expect(stage?.browser).toEqual({ profile: "inline_profile", headed: true });
    expect(stage?.requires).toHaveLength(1);
    expect(stage?.requires?.[0]?.tool).toBe("agent-browser");
    expect(stage?.requires?.[0]?.version).toContain(">=0.30.0");
  });

  it("leaves browser and requires unset on stages without browser", async () => {
    const loaded = await loadPipeline(SINGLE_PIPELINE);
    for (const stage of loaded.stages) {
      expect(stage.browser).toBeUndefined();
      expect(stage.requires).toBeUndefined();
    }
  });

  it("accepts a single-string logged_out_url", async () => {
    const loaded = await loadInlineBrowser([
      "check:",
      "  url: https://example.com/",
      "  logged_out_url: https://example.com/login*",
    ]);
    expect(loaded.stages[0]?.browser?.check?.logged_out_url).toBe(
      "https://example.com/login*",
    );
  });

  const invalid: Array<[string, string[]]> = [
    ["unknown key", ["profile: a", "viewport: big"]],
    ["path key", ["path: /tmp/profile"]],
    ["scope key", ["scope: other"]],
    ["secret key", ["secret: x"]],
    ["profile with path separator", ["profile: ../escape"]],
    ["profile with slash", ["profile: a/b"]],
    ["empty profile", ['profile: ""']],
    ["overlong profile", [`profile: ${"a".repeat(65)}`]],
    ["non-string profile", ["profile: 12"]],
    ["non-boolean headed", ['headed: "yes"']],
    ["empty allow_domains", ["allow_domains: []"]],
    ["string allow_domains", ["allow_domains: example.com"]],
    ["URL in allow_domains", ["allow_domains: ['https://example.com']"]],
    ["path in allow_domains", ["allow_domains: ['example.com/feed']"]],
    ["check without url", ["check:", "  logged_in_url: https://x/*"]],
    ["check unknown key", ["check:", "  url: https://x/", "  selector: a"]],
    ["empty logged_out_url list", ["check:", "  url: https://x/", "  logged_out_url: []"]],
    ["non-object browser", ["- a"]],
  ];

  it.each(invalid)("rejects %s with stage.invalid_browser", async (_name, lines) => {
    const dir = await mkdtemp(path.join(tmpdir(), "sf-browser-bad-"));
    const file = path.join(dir, "p.pipeline.yaml");
    const body = ["    browser:", ...lines.map((l) => `      ${l}`)];
    await writeFile(
      file,
      [
        "id: p",
        "stages:",
        "  - id: worker",
        "    system_prompt: x",
        "    model: anthropic/claude-sonnet-4-5",
        "    io:",
        "      input:",
        "        schema:",
        "          type: object",
        "      output:",
        "        schema:",
        "          type: object",
        ...body,
        "",
      ].join("\n"),
    );
    await expect(loadPipeline(file)).rejects.toThrow(/browser/);
  });

  it("rejects an invalid browser on a uses wrapper entry", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sf-browser-wrap-"));
    await writeFile(
      path.join(dir, "worker.yaml"),
      [
        "id: worker",
        "system_prompt: x",
        "model: anthropic/claude-sonnet-4-5",
        "io:",
        "  input:",
        "    schema:",
        "      type: object",
        "  output:",
        "    schema:",
        "      type: object",
        "",
      ].join("\n"),
    );
    const file = path.join(dir, "p.pipeline.yaml");
    await writeFile(
      file,
      [
        "id: p",
        "stages:",
        "  - id: worker",
        "    uses: ./worker.yaml",
        "    browser:",
        "      scope: other",
        "",
      ].join("\n"),
    );
    await expect(loadPipeline(file)).rejects.toThrow(/browser/);
  });
});
