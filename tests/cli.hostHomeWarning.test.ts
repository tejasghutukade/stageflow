import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetStageflowHomeIdsForTests, stageflowHomeId } from "../src/diagnostics/checks.js";
import { warnIfHostUsesOtherHome } from "../src/cli/hostHomeWarning.js";
import { resetGlobalStageflowHomeForTests } from "../src/project/globalHome.js";
import { freePort } from "./helpers/freePort.js";

const saved = { home: process.env.STAGEFLOW_HOME, port: process.env.STAGEFLOW_SERVICE_PORT };
const servers: http.Server[] = [];

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

async function fakeHost(homeId: string): Promise<number> {
  const port = await freePort();
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, status: "live", service: "stageflow", version: "0", home_id: homeId }));
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", () => resolve()));
  servers.push(server);
  return port;
}

function useHome(): string {
  const home = mkdtempSync(path.join(tmpdir(), "sf-warn-home-"));
  process.env.STAGEFLOW_HOME = home;
  resetGlobalStageflowHomeForTests();
  resetStageflowHomeIdsForTests();
  return stageflowHomeId();
}

afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
  restore("STAGEFLOW_HOME", saved.home);
  restore("STAGEFLOW_SERVICE_PORT", saved.port);
  delete process.env.STAGEFLOW_NO_HOST_HOME_WARNING;
  resetGlobalStageflowHomeForTests();
  resetStageflowHomeIdsForTests();
  vi.restoreAllMocks();
});

function capture() {
  const err: string[] = [];
  const out: string[] = [];
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void err.push(a.join(" ")));
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
  return { err, out };
}

describe("host home warning", () => {
  it("warns on stderr naming both home ids when the Host uses another home", async () => {
    const mine = useHome();
    process.env.STAGEFLOW_SERVICE_PORT = String(await fakeHost("host-home-other"));
    const { err, out } = capture();
    for (const command of ["run", "runs", "artifact"]) await warnIfHostUsesOtherHome(command);
    expect(out).toEqual([]);
    expect(err).toHaveLength(3);
    expect(err[0]).toContain("host-home-other");
    expect(err[0]).toContain(mine);
    expect(err[0]).toContain("docker exec");
  });

  it("is silent when the Host has the same home", async () => {
    const mine = useHome();
    process.env.STAGEFLOW_SERVICE_PORT = String(await fakeHost(mine));
    const { err } = capture();
    await warnIfHostUsesOtherHome("run");
    expect(err).toEqual([]);
  });

  it("is silent with no Host, for other commands, and when opted out", async () => {
    useHome();
    process.env.STAGEFLOW_SERVICE_PORT = String(await freePort());
    const { err } = capture();
    await warnIfHostUsesOtherHome("run");
    process.env.STAGEFLOW_SERVICE_PORT = String(await fakeHost("host-home-other"));
    await warnIfHostUsesOtherHome("validate");
    process.env.STAGEFLOW_NO_HOST_HOME_WARNING = "1";
    await warnIfHostUsesOtherHome("run");
    expect(err).toEqual([]);
  });
});
