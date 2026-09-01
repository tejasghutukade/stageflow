import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  "resolve-catalog-id.mjs",
);

const ID_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function emptyDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "sf-resolve-id-"));
  temps.push(dir);
  return dir;
}

function runResolve(args: string[]) {
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
}

function parseId(stdout: string): string {
  const parsed = JSON.parse(stdout.trim()) as { id: string };
  return parsed.id;
}

describe("resolve-catalog-id.mjs", () => {
  it("slugifies free text to a valid pipeline id in an empty dir", () => {
    const dir = emptyDir();
    const result = runResolve([
      "--text",
      "Ship the login redesign",
      "--dir",
      dir,
      "--kind",
      "pipeline",
    ]);
    expect(result.status, result.stderr).toBe(0);
    const id = parseId(result.stdout);
    expect(id).toMatch(ID_PATTERN);
    expect(id.length).toBeGreaterThanOrEqual(1);
    expect(id.length).toBeLessThanOrEqual(64);
    expect(id).toBe("ship-the-login-redesign");
  });

  it("corrects a digit start and leftover hyphens so the id still matches the pattern", () => {
    const dir = emptyDir();
    const result = runResolve([
      "--text",
      "---9 Launch / Review---",
      "--dir",
      dir,
      "--kind",
      "stage",
    ]);
    expect(result.status, result.stderr).toBe(0);
    const id = parseId(result.stdout);
    expect(id).toMatch(ID_PATTERN);
    expect(id.startsWith("-")).toBe(false);
    expect(/^[0-9]/.test(id)).toBe(false);
  });

  it("truncates long text to 64 characters without a dangling hyphen", () => {
    const dir = emptyDir();
    const result = runResolve([
      "--text",
      "Alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho",
      "--dir",
      dir,
      "--kind",
      "pipeline",
    ]);
    expect(result.status, result.stderr).toBe(0);
    const id = parseId(result.stdout);
    expect(id.length).toBeLessThanOrEqual(64);
    expect(id.endsWith("-")).toBe(false);
    expect(id).toMatch(ID_PATTERN);
  });

  it("appends -2 when the derived slug already exists as a top-level id", () => {
    const dir = emptyDir();
    writeFileSync(
      path.join(dir, "existing.yaml"),
      ["id: ship-the-login-redesign", "system_prompt: keep", "model: anthropic/claude-sonnet-4-5", ""].join(
        "\n",
      ),
    );
    const result = runResolve([
      "--text",
      "Ship the login redesign",
      "--dir",
      dir,
      "--kind",
      "stage",
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(parseId(result.stdout)).toBe("ship-the-login-redesign-2");
  });

  it("leaves the colliding file untouched", () => {
    const dir = emptyDir();
    const existing = path.join(dir, "existing.yml");
    const original = "id: ship-the-login-redesign\n";
    writeFileSync(existing, original);
    runResolve([
      "--text",
      "Ship the login redesign",
      "--dir",
      dir,
      "--kind",
      "pipeline",
    ]);
    expect(readFileSync(existing, "utf8")).toBe(original);
  });

  it("rejects an invalid --kind and names the allowed values on stderr", () => {
    const dir = emptyDir();
    const result = runResolve(["--text", "demo", "--dir", dir, "--kind", "widget"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/pipeline/);
    expect(result.stderr).toMatch(/stage/);
  });

  it("does not treat a nested id as a collision", () => {
    const dir = emptyDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "other.pipeline.yaml"),
      ["id: other", "stages:", "  - id: ship-the-login-redesign", "    uses: ./x.yaml", ""].join("\n"),
    );
    const result = runResolve([
      "--text",
      "Ship the login redesign",
      "--dir",
      dir,
      "--kind",
      "stage",
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(parseId(result.stdout)).toBe("ship-the-login-redesign");
  });
});
