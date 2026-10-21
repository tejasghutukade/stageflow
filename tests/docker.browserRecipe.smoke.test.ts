import { execFile, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const enabled = process.env.STAGEFLOW_DOCKER_SMOKE === "1";

function dockerAvailable(): boolean {
  if (!enabled) return false;
  try {
    execFileSync("docker", ["info", "--format", "{{.ServerVersion}}"], { stdio: "ignore", timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const suffix = randomBytes(4).toString("hex");
const baseTag = `sf-recipe-smoke-base-${suffix}`;
const browserTag = `sf-recipe-smoke-browser-${suffix}`;
const containerName = `sf-recipe-smoke-${suffix}`;

function docker(args: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile("docker", args, { cwd: repoRoot, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({
        code: err ? ((err as { code?: number }).code ?? 1) : 0,
        stdout: String(stdout),
        stderr: String(stderr),
      }),
    );
  });
}

describe.skipIf(!dockerAvailable())("browser image recipe, real Chromium (STAGEFLOW_DOCKER_SMOKE=1)", () => {
  afterAll(async () => {
    await docker(["rm", "-f", "-v", containerName], 60_000);
    await docker(["rmi", browserTag], 120_000);
    await docker(["rmi", baseTag], 120_000);
  }, 300_000);

  it("runs a human login stage with no screen through the live view", async () => {
    const base = await docker(["build", "--target", "runtime", "-t", baseTag, "."], 1_200_000);
    expect(base.code, base.stderr.slice(-2000)).toBe(0);
    const recipe = await docker(
      ["build", "-f", "docker/Dockerfile.browser", "--build-arg", `BASE_IMAGE=${baseTag}`, "-t", browserTag, "."],
      1_200_000,
    );
    expect(recipe.code, recipe.stderr.slice(-2000)).toBe(0);

    const run = await docker(
      [
        "run",
        "--rm",
        "--name",
        containerName,
        "--shm-size=1g",
        "-e",
        "STAGEFLOW_HOME=/tmp/sfh",
        "-v",
        `${path.join(repoRoot, "docker/browser.config.example.yaml")}:/config.example.yaml:ro`,
        "-v",
        `${path.join(repoRoot, "tests/fixtures/docker/browser-recipe-probe.mjs")}:/probe.mjs:ro`,
        browserTag,
        "node",
        "/probe.mjs",
      ],
      300_000,
    );
    const line = run.stdout.split("\n").find((l) => l.startsWith("PROBE_RESULT "));
    expect(line, `${run.stdout.slice(-2000)}\n${run.stderr.slice(-2000)}`).toBeDefined();
    const result = JSON.parse(line!.slice("PROBE_RESULT ".length)) as {
      env: { DISPLAY: string | null };
      capabilities: { display: string; liveView: string };
      resolved?: { ok: boolean; headed?: string };
      page?: { href: string };
      userAgent?: string;
      frame?: boolean;
      commandLine?: string[];
      permissions?: { notification: string; geolocation: number | string; clipboard: string; ms: number };
      controlPermissions?: { notification?: string; geolocation?: number | string; clipboard?: string; error?: string };
      error?: string;
    };
    expect(result.error).toBeUndefined();
    expect(result.env.DISPLAY).toBeNull();
    expect(result.capabilities).toEqual({ display: "virtual_display", liveView: "relay" });
    expect(result.resolved).toEqual({ ok: true, headed: "1" });
    expect(result.page?.href).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/login/);
    expect(result.frame).toBe(true);
    expect(result.userAgent).toMatch(/Chrome\//);
    expect(result.userAgent).not.toContain("HeadlessChrome");
    expect(result.commandLine).toContain("--deny-permission-prompts");
    expect(result.permissions?.notification).toBe("denied");
    expect(result.permissions?.geolocation).toBe(1);
    expect(result.permissions?.clipboard).toMatch(/^rejected:/);
    expect(result.permissions!.ms).toBeLessThan(2000);
    console.log(`recipe smoke permissions: ${JSON.stringify(result.permissions)}`);
    console.log(`recipe smoke control (no deny switch): ${JSON.stringify(result.controlPermissions)}`);
    console.log(`recipe smoke user agent: ${result.userAgent}`);
  }, 2_400_000);
});
