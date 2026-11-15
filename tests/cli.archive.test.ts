import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { runArchiveCommand } from "../src/cli/archiveCommand.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { globalStageflowHome } from "../src/project/globalHome.js";
import { withIsolatedHome } from "./helpers/projectContext.js";

const CANARY = "CANARY-SECRET-0e7d";

function io() {
  const lines: string[] = [];
  return { lines, io: { log: (line: string) => lines.push(line), error: (line: string) => lines.push(line) } };
}

function seed(home: string): void {
  createRunStore({ rootDir: home, openerMode: "migrate" });
  mkdirSync(path.join(home, "agent"), { recursive: true });
  writeFileSync(path.join(home, "agent", "auth.json"), `{"key":"${CANARY}"}\n`, { mode: 0o600 });
  writeFileSync(path.join(home, "settings.json"), "{}\n");
}

describe("sf archive CLI", () => {
  it("writes an archive under backups/ without secrets and reports counts as json", async () => {
    await withIsolatedHome(async () => {
      const home = globalStageflowHome();
      seed(home);
      const { lines, io: sink } = io();
      expect(await runArchiveCommand(["--json"], { io: sink })).toBe(0);
      const result = JSON.parse(lines.find((line) => line.startsWith("{"))!);
      expect(result.path).toContain(path.join(home, "backups"));
      expect(existsSync(result.path)).toBe(true);
      expect(result.contains_secrets).toBe(false);
      expect(result.archive_version).toBe(1);
      expect(statSync(result.path).mode & 0o777).toBe(0o600);
      const listing = spawnSync("tar", ["-tzf", result.path], { encoding: "utf8" }).stdout;
      expect(listing).toContain("state.db");
      expect(listing).toContain("settings.json");
      expect(listing).toContain("manifest.json");
      expect(listing).not.toContain("agent/auth.json");
      expect(lines.join("\n")).not.toContain(CANARY);
      expect(lines.join("\n")).not.toMatch(/warning/);
    });
  });

  it("includes secrets only on request and warns about it", async () => {
    await withIsolatedHome(async () => {
      const home = globalStageflowHome();
      seed(home);
      const { lines, io: sink } = io();
      expect(await runArchiveCommand(["--include-secrets", "--json"], { io: sink })).toBe(0);
      const result = JSON.parse(lines.find((line) => line.startsWith("{"))!);
      expect(result.contains_secrets).toBe(true);
      expect(lines.join("\n")).toMatch(/warning: this archive contains secrets/);
      expect(spawnSync("tar", ["-tzf", result.path], { encoding: "utf8" }).stdout).toContain("agent/auth.json");
    });
  });

  it("refuses --out under runs/ or worktrees/ and bad flags, and prints help", async () => {
    await withIsolatedHome(async () => {
      const home = globalStageflowHome();
      seed(home);
      for (const bad of ["runs", "worktrees"]) {
        const { lines, io: sink } = io();
        expect(await runArchiveCommand(["--out", path.join(home, bad, "x.tar.gz")], { io: sink })).toBe(1);
        expect(lines.join("\n")).toMatch(/archive_out_denied/);
      }
      let sink = io();
      expect(await runArchiveCommand(["--nope"], { io: sink.io })).toBe(1);
      expect(sink.lines.join("\n")).toMatch(/Unknown flag/);
      sink = io();
      expect(await runArchiveCommand(["--out"], { io: sink.io })).toBe(1);
      sink = io();
      expect(await runArchiveCommand(["--help"], { io: sink.io })).toBe(0);
      expect(sink.lines.join("\n")).toMatch(/sf archive/);
    });
  });
});
