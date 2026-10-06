import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(
  root,
  "skills",
  "stageflow-session-capture",
  "scripts",
  "locate-session-transcript.mjs",
);

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function encodeClaudeProject(cwd: string): string {
  return cwd.replace(/[/\\:]/g, "-");
}

function writeJsonl(filePath: string, mtimeSec: number): string {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, '{"type":"message"}\n');
  utimesSync(filePath, mtimeSec, mtimeSec);
  return filePath;
}

function runLocate(args: string[]) {
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
}

function parseStdout(stdout: string) {
  return JSON.parse(stdout.trim()) as Record<string, unknown>;
}

describe("locate-session-transcript.mjs", () => {
  it("returns the newest Claude Code jsonl under the cwd-encoded project", () => {
    const home = tempDir("sf-locate-home-");
    const cwd = tempDir("sf-locate-cwd-");
    const project = path.join(home, ".claude", "projects", encodeClaudeProject(cwd));
    writeJsonl(path.join(project, "older.jsonl"), 1_700_000_000);
    const newer = writeJsonl(path.join(project, "nested", "newer.jsonl"), 1_800_000_000);
    const result = runLocate(["--home", home, "--cwd", cwd]);
    expect(result.status, result.stderr).toBe(0);
    expect(parseStdout(result.stdout)).toEqual({
      ok: true,
      path: newer,
      source: "claude-code",
    });
  });

  it("returns the newest Codex rollout jsonl across the date tree", () => {
    const home = tempDir("sf-locate-home-");
    const cwd = tempDir("sf-locate-cwd-");
    const sessions = path.join(home, ".codex", "sessions");
    writeJsonl(path.join(sessions, "2026", "01", "01", "rollout-old.jsonl"), 1_700_000_000);
    const newest = writeJsonl(
      path.join(sessions, "2026", "08", "31", "rollout-new.jsonl"),
      1_800_000_000,
    );
    writeJsonl(path.join(sessions, "2026", "08", "31", "notes.jsonl"), 1_900_000_000);
    const result = runLocate(["--home", home, "--cwd", cwd]);
    expect(result.status, result.stderr).toBe(0);
    expect(parseStdout(result.stdout)).toEqual({
      ok: true,
      path: newest,
      source: "codex",
    });
  });

  it("returns a Pi session jsonl match", () => {
    const home = tempDir("sf-locate-home-");
    const cwd = tempDir("sf-locate-cwd-");
    const match = writeJsonl(
      path.join(home, ".pi", "agent", "sessions", "abc", "chat.jsonl"),
      1_800_000_000,
    );
    const result = runLocate(["--home", home, "--cwd", cwd]);
    expect(result.status, result.stderr).toBe(0);
    expect(parseStdout(result.stdout)).toEqual({
      ok: true,
      path: match,
      source: "pi",
    });
  });

  it("honors --path and skips probing even when other fixtures exist", () => {
    const home = tempDir("sf-locate-home-");
    const cwd = tempDir("sf-locate-cwd-");
    writeJsonl(
      path.join(home, ".claude", "projects", encodeClaudeProject(cwd), "probe.jsonl"),
      1_800_000_000,
    );
    const explicit = path.join(tempDir("sf-locate-explicit-"), "past.txt");
    writeFileSync(explicit, "pasted history\n");
    const result = runLocate(["--path", explicit, "--home", home, "--cwd", cwd]);
    expect(result.status, result.stderr).toBe(0);
    expect(parseStdout(result.stdout)).toEqual({
      ok: true,
      path: explicit,
      source: "explicit",
    });
  });

  it("returns unreadable when --path is missing", () => {
    const missing = path.join(tempDir("sf-locate-missing-"), "gone.jsonl");
    const result = runLocate(["--path", missing]);
    expect(result.status, result.stderr).toBe(1);
    expect(parseStdout(result.stdout)).toEqual({
      ok: false,
      reason: "unreadable",
    });
  });

  it("returns not_found when no probed store has a jsonl", () => {
    const home = tempDir("sf-locate-empty-");
    const cwd = tempDir("sf-locate-cwd-");
    const result = runLocate(["--home", home, "--cwd", cwd]);
    expect(result.status, result.stderr).toBe(1);
    expect(parseStdout(result.stdout)).toEqual({
      ok: false,
      reason: "not_found",
    });
  });
});
