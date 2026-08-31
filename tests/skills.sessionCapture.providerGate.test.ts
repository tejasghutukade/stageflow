import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  "check-provider-gate.mjs",
);

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function writeFakeSf(stdout: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "sf-session-capture-sf-"));
  temps.push(dir);
  const bin = path.join(dir, "sf");
  writeFileSync(
    bin,
    `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(stdout)});\n`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

function runGate(sfBin: string) {
  return spawnSync(process.execPath, [script, "--sf-bin", sfBin], {
    encoding: "utf8",
  });
}

function parseStdout(stdout: string) {
  return JSON.parse(stdout.trim()) as Record<string, unknown>;
}

describe("check-provider-gate.mjs", () => {
  it("exits 0 with ok true when one row is configured", () => {
    const bin = writeFakeSf("anthropic\tconfigured\tkind=api_key\n");
    const result = runGate(bin);
    expect(result.status, result.stderr).toBe(0);
    expect(parseStdout(result.stdout)).toEqual({ ok: true });
  });

  it("exits 0 when a configured row sits among disconnected rows", () => {
    const bin = writeFakeSf(
      [
        "openai\tdisconnected",
        "anthropic\tconfigured\tkind=oauth\tsource=sf_owned",
        "google\tdisconnected",
        "",
      ].join("\n"),
    );
    const result = runGate(bin);
    expect(result.status, result.stderr).toBe(0);
    expect(parseStdout(result.stdout)).toEqual({ ok: true });
  });

  it("exits 1 with no_provider_configured when every row is disconnected", () => {
    const bin = writeFakeSf("anthropic\tdisconnected\nopenai\tdisconnected\n");
    const result = runGate(bin);
    expect(result.status, result.stderr).toBe(1);
    expect(parseStdout(result.stdout)).toEqual({
      ok: false,
      reason: "no_provider_configured",
    });
  });

  it("exits 1 with sf_not_found when --sf-bin is missing", () => {
    const result = runGate(path.join(tmpdir(), "sf-missing-bin-does-not-exist"));
    expect(result.status, result.stderr).toBe(1);
    expect(parseStdout(result.stdout)).toEqual({
      ok: false,
      reason: "sf_not_found",
    });
  });
});
