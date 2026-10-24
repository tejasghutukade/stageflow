import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const GUARD_FILENAME = "guard.cjs";

export const GUARD_SOURCE = `"use strict";
const http = require("node:http");
const https = require("node:https");
const { Writable } = require("node:stream");

const BLOCKED = ["promptfoo.app", "promptfoo.dev"];

function isBlocked(host) {
  if (typeof host !== "string") return false;
  const h = host.toLowerCase().replace(/\\.$/, "").replace(/^\\[|\\]$/g, "");
  return BLOCKED.some((d) => h === d || h.endsWith("." + d));
}

function hostOf(input) {
  if (typeof input === "string") {
    try { return new URL(input).hostname; } catch { return undefined; }
  }
  if (input instanceof URL) return input.hostname;
  if (input && typeof input === "object") {
    if (typeof input.hostname === "string") return input.hostname;
    if (typeof input.host === "string") return input.host.replace(/:\\d+$/, "");
    if (typeof input.url === "string") return hostOf(input.url);
  }
  return undefined;
}

function blockedError(host) {
  const err = new Error("Stageflow blocked network access to " + host);
  err.code = "ECONNREFUSED";
  return err;
}

function failedRequest(host) {
  const req = new Writable({ write(_c, _e, cb) { cb(); } });
  for (const name of ["setHeader", "setTimeout", "setNoDelay", "setSocketKeepAlive", "flushHeaders", "abort"]) {
    req[name] = () => req;
  }
  process.nextTick(() => req.emit("error", blockedError(host)));
  return req;
}

function wrap(mod, name) {
  const original = mod[name];
  mod[name] = function (...args) {
    const host = hostOf(args[0]);
    if (isBlocked(host)) return failedRequest(host);
    return original.apply(this, args);
  };
}

for (const mod of [http, https]) {
  wrap(mod, "request");
  wrap(mod, "get");
}

if (typeof globalThis.fetch === "function") {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = function (input, init) {
    const host = hostOf(input);
    if (isBlocked(host)) return Promise.reject(blockedError(host));
    return originalFetch.call(this, input, init);
  };
}

try { require("node:module").syncBuiltinESMExports(); } catch {}
`;

export function writeGuardFile(dir: string): string {
  const file = path.join(dir, GUARD_FILENAME);
  writeFileSync(file, GUARD_SOURCE);
  return file;
}

export type GuardVia = "fetch" | "http" | "https";
export type GuardProbeResult = { blocked: boolean; status?: number; code?: string };

const PROBE_SCRIPT = `
const [via, url] = process.argv.slice(1);
const out = (o) => { process.stdout.write(JSON.stringify(o)); process.exit(0); };
const fail = (e) => out({ blocked: true, code: e && e.code });
if (via === "fetch") {
  fetch(url).then((r) => out({ blocked: false, status: r.status }), fail);
} else {
  const mod = require(via);
  try {
    const req = mod.request(url, (res) => { res.resume(); out({ blocked: false, status: res.statusCode }); });
    req.on("error", fail);
    req.end();
  } catch (e) { fail(e); }
}
`;

export async function probeGuard(via: GuardVia, url: string): Promise<GuardProbeResult> {
  const dir = mkdtempSync(path.join(tmpdir(), "sf-guard-"));
  try {
    const guard = writeGuardFile(dir);
    return await new Promise<GuardProbeResult>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ["--require", guard, "-e", PROBE_SCRIPT, via, url],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("error", reject);
      child.on("close", () => {
        try {
          resolve(JSON.parse(stdout) as GuardProbeResult);
        } catch {
          reject(new Error(`guard probe failed: ${stderr || stdout}`));
        }
      });
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
