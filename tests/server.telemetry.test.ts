import { statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import { applyOpenUiTelemetryEnv } from "../src/artifacts/library/telemetryEnv.js";
import { resetGlobalStageflowHomeForTests } from "../src/project/globalHome.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { loadControlTokens } from "../src/server/controlToken.js";
import { startUiServer } from "../src/server/http.js";
import { createTelemetryConsent } from "../src/telemetry/consent.js";
import {
  readTelemetryEnvSnapshot,
  resetTelemetryEnvSnapshotForTests,
  setTelemetryEnvSnapshotForTests,
} from "../src/telemetry/envSnapshot.js";
import { closeServer } from "./helpers/closeServer.js";
import { bindStageflowHomeForTests } from "./helpers/workspaceTestHarness.js";

const DRIVE = "d".repeat(32);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const ORIGINAL_HOME = process.env.STAGEFLOW_HOME;
const ORIGINAL_DNT = process.env.DO_NOT_TRACK;
const ORIGINAL_TELEMETRY = process.env.STAGEFLOW_TELEMETRY;
const ORIGINAL_CI = process.env.CI;

const servers: Array<{ close: (cb?: () => void) => void }> = [];
const dirs: string[] = [];

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => closeServer(server)));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  restoreEnv("DO_NOT_TRACK", ORIGINAL_DNT);
  restoreEnv("STAGEFLOW_TELEMETRY", ORIGINAL_TELEMETRY);
  restoreEnv("CI", ORIGINAL_CI);
  restoreEnv("STAGEFLOW_HOME", ORIGINAL_HOME);
  resetGlobalStageflowHomeForTests();
  resetTelemetryEnvSnapshotForTests();
});

beforeEach(() => {
  setTelemetryEnvSnapshotForTests({});
});

async function startHost(existingHome?: string) {
  const home = existingHome ?? (await mkdtemp(path.join(tmpdir(), "sf-telemetry-")));
  if (!dirs.includes(home)) dirs.push(home);
  bindStageflowHomeForTests(home);
  const started = await startUiServer({
    agent: scriptedFakeAgent([]),
    cwd: home,
    rootDir: home,
    store: createRunStore({ rootDir: home }),
    port: 0,
    uiDistDir: path.join(home, "missing-ui"),
    controlTokens: loadControlTokens({ STAGEFLOW_CONTROL_TOKEN: DRIVE }),
  });
  servers.push(started.server);
  const address = started.server.address();
  if (!address || typeof address === "string") throw new Error("expected a port");
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { Authorization: `Bearer ${DRIVE}`, "Content-Type": "application/json" };
  const call = async (method: string, urlPath: string, body?: unknown) => {
    const response = await fetch(`${base}${urlPath}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    return {
      status: response.status,
      body: (text ? JSON.parse(text) : {}) as Record<string, unknown>,
    };
  };
  return { home, base, headers, call, server: started.server };
}

async function stop(server: { close: (cb?: () => void) => void }): Promise<void> {
  const index = servers.indexOf(server);
  if (index >= 0) servers.splice(index, 1);
  await closeServer(server);
}

describe("telemetry consent HTTP API", () => {
  it("starts disabled with a stable random install id", async () => {
    process.env.DO_NOT_TRACK = "1";
    process.env.CI = "true";
    process.env.STAGEFLOW_TELEMETRY = "0";
    const { home, call } = await startHost();
    const first = await call("GET", "/api/telemetry");
    const second = await call("GET", "/api/telemetry");
    expect(first.status).toBe(200);
    expect(first.body).toEqual({
      enabled: false,
      storedEnabled: false,
      locked: null,
      installId: expect.stringMatching(UUID),
      promptedVersion: null,
      decidedAt: null,
    });
    expect(second.body).toEqual(first.body);
    expect(statSync(path.join(home, "telemetry.json")).mode & 0o777).toBe(0o600);
    const otherHome = await mkdtemp(path.join(tmpdir(), "sf-telemetry-other-"));
    dirs.push(otherHome);
    const other = createTelemetryConsent({
      homeDir: otherHome,
      snapshot: readTelemetryEnvSnapshot(),
    });
    expect(other.getState().installId).not.toBe(first.body.installId);
    expect(other.isTelemetryEnabled()).toBe(false);
  });

  it("persists enable and disable across a host restart", async () => {
    const first = await startHost();
    const enabled = await first.call("PUT", "/api/telemetry", { enabled: true, promptedVersion: 3 });
    expect(enabled.status).toBe(200);
    expect(enabled.body).toMatchObject({
      enabled: true,
      storedEnabled: true,
      locked: null,
      promptedVersion: 3,
    });
    expect(enabled.body.decidedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(createTelemetryConsent({
      homeDir: first.home,
      snapshot: readTelemetryEnvSnapshot(),
    }).isTelemetryEnabled()).toBe(true);

    await stop(first.server);
    const second = await startHost(first.home);
    const stillOn = await second.call("GET", "/api/telemetry");
    expect(stillOn.body).toEqual(enabled.body);

    const disabled = await second.call("PUT", "/api/telemetry", { enabled: false });
    expect(disabled.body).toMatchObject({
      enabled: false,
      storedEnabled: false,
      promptedVersion: 3,
      installId: enabled.body.installId,
    });
    await stop(second.server);
    const third = await startHost(first.home);
    const stillOff = await third.call("GET", "/api/telemetry");
    expect(stillOff.body).toMatchObject({
      enabled: false,
      storedEnabled: false,
      promptedVersion: 3,
      installId: enabled.body.installId,
      decidedAt: disabled.body.decidedAt,
    });
  });

  it("does not lock when the original DO_NOT_TRACK was unset", async () => {
    delete process.env.DO_NOT_TRACK;
    delete process.env.STAGEFLOW_TELEMETRY;
    delete process.env.CI;
    resetTelemetryEnvSnapshotForTests();
    applyOpenUiTelemetryEnv();
    expect(process.env.DO_NOT_TRACK).toBe("1");
    expect(readTelemetryEnvSnapshot().doNotTrack).toBeUndefined();

    const { call } = await startHost();
    const got = await call("GET", "/api/telemetry");
    expect(got.status).toBe(200);
    expect(got.body).toMatchObject({ enabled: false, storedEnabled: false, locked: null });
    expect(process.env.DO_NOT_TRACK).toBe("1");
  });

  it("locks off when the original DO_NOT_TRACK was set", async () => {
    process.env.DO_NOT_TRACK = "1";
    delete process.env.STAGEFLOW_TELEMETRY;
    delete process.env.CI;
    resetTelemetryEnvSnapshotForTests();
    applyOpenUiTelemetryEnv();
    expect(process.env.DO_NOT_TRACK).toBe("1");

    const { call } = await startHost();
    const got = await call("GET", "/api/telemetry");
    expect(got.body).toMatchObject({ enabled: false, storedEnabled: false, locked: "env" });
    const put = await call("PUT", "/api/telemetry", { enabled: true, promptedVersion: 1 });
    expect(put.status).toBe(409);
    expect(put.body).toEqual({ code: "TELEMETRY_LOCKED", error: "Telemetry consent is locked" });
    const after = await call("GET", "/api/telemetry");
    expect(after.body).toEqual(got.body);
  });

  it("locks from the startup snapshot, not the live process env", async () => {
    process.env.DO_NOT_TRACK = "1";
    process.env.STAGEFLOW_TELEMETRY = "0";
    process.env.CI = "true";
    const { call } = await startHost();
    const cases: Array<{
      snapshot: { doNotTrack?: string; stageflowTelemetry?: string; ci?: string };
      locked: "env" | "ci" | null;
      enabled: boolean;
    }> = [
      { snapshot: {}, locked: null, enabled: false },
      { snapshot: { stageflowTelemetry: "0" }, locked: "env", enabled: false },
      { snapshot: { stageflowTelemetry: "false" }, locked: "env", enabled: false },
      { snapshot: { stageflowTelemetry: "FALSE" }, locked: "env", enabled: false },
      { snapshot: { stageflowTelemetry: "1" }, locked: null, enabled: true },
      { snapshot: { stageflowTelemetry: "true" }, locked: null, enabled: true },
      { snapshot: { stageflowTelemetry: "yes" }, locked: null, enabled: false },
      { snapshot: { ci: "true" }, locked: "ci", enabled: false },
      { snapshot: { ci: "TRUE" }, locked: "ci", enabled: false },
      { snapshot: { ci: "1" }, locked: null, enabled: false },
      { snapshot: { ci: "true", stageflowTelemetry: "1" }, locked: null, enabled: true },
      { snapshot: { doNotTrack: "1", stageflowTelemetry: "1" }, locked: "env", enabled: false },
      { snapshot: { doNotTrack: "true", ci: "true", stageflowTelemetry: "1" }, locked: "env", enabled: false },
      { snapshot: { doNotTrack: " 1 " }, locked: "env", enabled: false },
    ];
    let installId: string | undefined;
    for (const entry of cases) {
      setTelemetryEnvSnapshotForTests(entry.snapshot);
      const got = await call("GET", "/api/telemetry");
      expect(got.status, JSON.stringify(entry.snapshot)).toBe(200);
      expect(got.body).toMatchObject({
        enabled: entry.enabled,
        storedEnabled: false,
        locked: entry.locked,
        decidedAt: null,
        promptedVersion: null,
      });
      expect(got.body.installId).toEqual(expect.stringMatching(UUID));
      installId ??= got.body.installId as string;
      expect(got.body.installId).toBe(installId);
      expect(createTelemetryConsent({
        homeDir: process.env.STAGEFLOW_HOME!,
        snapshot: readTelemetryEnvSnapshot(),
      }).isTelemetryEnabled()).toBe(entry.enabled);
    }
  });

  it("resets the install id and keeps the consent choice", async () => {
    const { call } = await startHost();
    const enabled = await call("PUT", "/api/telemetry", { enabled: true, promptedVersion: 4 });
    const reset = await call("POST", "/api/telemetry/reset-id");
    expect(reset.status).toBe(200);
    expect(reset.body).toMatchObject({
      enabled: true,
      storedEnabled: true,
      locked: null,
      promptedVersion: 4,
      decidedAt: enabled.body.decidedAt,
    });
    expect(reset.body.installId).toEqual(expect.stringMatching(UUID));
    expect(reset.body.installId).not.toBe(enabled.body.installId);

    setTelemetryEnvSnapshotForTests({ doNotTrack: "1" });
    const locked = await call("POST", "/api/telemetry/reset-id");
    expect(locked.status).toBe(200);
    expect(locked.body).toMatchObject({
      enabled: false,
      storedEnabled: true,
      locked: "env",
      promptedVersion: 4,
      decidedAt: enabled.body.decidedAt,
    });
    expect(locked.body.installId).not.toBe(reset.body.installId);
    const put = await call("PUT", "/api/telemetry", { enabled: false });
    expect(put.status).toBe(409);
    expect(put.body).toMatchObject({ code: "TELEMETRY_LOCKED" });
    const after = await call("GET", "/api/telemetry");
    expect(after.body).toEqual(locked.body);
  });

  it("rejects an invalid consent body and keeps an omitted prompt version", async () => {
    const { call } = await startHost();
    const missing = await call("PUT", "/api/telemetry", {});
    expect(missing.status).toBe(400);
    expect(missing.body).toMatchObject({ code: "TELEMETRY_INVALID" });
    const wrongType = await call("PUT", "/api/telemetry", { enabled: "yes" });
    expect(wrongType.status).toBe(400);
    expect(wrongType.body).toMatchObject({ code: "TELEMETRY_INVALID", error: "enabled must be a boolean" });
    const fraction = await call("PUT", "/api/telemetry", { enabled: true, promptedVersion: 1.5 });
    expect(fraction.status).toBe(400);
    expect(fraction.body).toMatchObject({ code: "TELEMETRY_INVALID" });
    const negative = await call("PUT", "/api/telemetry", { enabled: true, promptedVersion: -1 });
    expect(negative.status).toBe(400);

    const saved = await call("PUT", "/api/telemetry", { enabled: true, promptedVersion: 2 });
    expect(saved.status).toBe(200);
    const kept = await call("PUT", "/api/telemetry", { enabled: false });
    expect(kept.body).toMatchObject({
      enabled: false,
      storedEnabled: false,
      promptedVersion: 2,
      installId: saved.body.installId,
    });
  });

  it("rejects consent writes without a control token", async () => {
    const { base } = await startHost();
    const put = await fetch(`${base}/api/telemetry`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(put.status).toBe(401);
    expect(await put.json()).toEqual({ error: "Unauthorized" });
    const reset = await fetch(`${base}/api/telemetry/reset-id`, { method: "POST" });
    expect(reset.status).toBe(401);
    expect(await reset.json()).toEqual({ error: "Unauthorized" });
  });
});
