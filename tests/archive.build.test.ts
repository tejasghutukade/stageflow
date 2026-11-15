import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, statSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { ArchiveError, buildArchive, type ArchiveManifest } from "../src/archive/build.js";
import { ARCHIVE_RULES, ruleFor } from "../src/archive/inventory.js";
import { createRunStoreWithConnection } from "../src/runstore/createStore.js";
import { storeRootFor } from "../src/runstore/paths.js";
import type { RunStore } from "../src/runstore/port.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

const CANARY = "CANARY-SECRET-VALUE-93f1";

async function makeHome(): Promise<{ home: string; store: RunStore }> {
  const root = await mkdtemp(path.join(tmpdir(), "sf-archive-"));
  const { store } = createRunStoreWithConnection({ rootDir: root, openerMode: "migrate" });
  cleanups.push(async () => {
    await store.close();
    await rm(root, { recursive: true, force: true });
  });
  return { home: storeRootFor(root), store };
}

function put(home: string, relative: string, content = relative): void {
  const file = path.join(home, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function plant(home: string): void {
  for (const file of [
    "settings.json", "connections.yaml", "a2a.yaml", "mcp/.mcp.json", "workspace/stageflow.yaml", "workspace/starters/a.pipeline.yaml",
    "memories/m1/memory.yaml", "memories/m1/body.md", "agents/pi-sessions/s1.jsonl", "workshop/builds/b1.json", "workshop/sessions/w1/session.json",
    ".stageflow/channel-sends.json", "identity/settings.json",
  ]) put(home, file);
  for (const file of [
    "agent/auth.json", "channel-secrets.json", "identity-secrets.json", "secrets/mcp-secrets.json", "secrets/mcp-oauth.key", "agent/mcp-oauth-encrypted",
    "agent/models.json",
  ]) put(home, file, `${file} ${CANARY}`);
  for (const file of [
    "eval-engine/x/package.json", "eval-runs/e1/out.json", "repos/h/o/r.git/HEAD", "worktrees/r1/file", "cache/jiti/a", "tmp/t", "backups/old.tar.gz", "restore-pending/m",
    "workshop/autosave/a.json", "host.lock", "host-id", "service.log", "agent/mcp-cache.json", "unknown-new-thing/file",
  ]) put(home, file);
  writeFileSync(path.join(home, "host-id"), "home-abc123\n");
  const identity = path.join(home, "identity", "consumer-identity.db");
  const db = new Database(identity);
  db.exec("CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO people (name) VALUES ('ada')");
  db.close();
}

function listing(archive: string): string[] {
  const result = spawnSync("tar", ["-tzf", archive], { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.split("\n").filter(Boolean).map((line) => line.replace(/\/$/, ""));
}

function extract(archive: string): string {
  const dir = path.join(tmpdir(), `sf-archive-x-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  cleanups.push(async () => rm(dir, { recursive: true, force: true }));
  const result = spawnSync("tar", ["-xzf", archive, "-C", dir], { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return dir;
}

const manifestOf = (dir: string): ArchiveManifest => JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8")) as ArchiveManifest;
const noRuns = { listRuns: async () => [] as Awaited<ReturnType<RunStore["listRuns"]>>, getWorkspaceDir: () => "" };

describe("buildArchive", () => {
  it("copies every keep path, no disposable path and no secret, and says what it left out", async () => {
    const { home, store } = await makeHome();
    plant(home);
    const result = await buildArchive({ store: { snapshotInto: store.snapshotInto.bind(store), ...noRuns }, homeDir: home });
    const names = listing(result.path);
    for (const keep of ["state.db", "settings.json", "connections.yaml", "a2a.yaml", "mcp/.mcp.json", "workspace/stageflow.yaml", "workspace/starters/a.pipeline.yaml",
      "memories/m1/memory.yaml", "memories/m1/body.md", "agents/pi-sessions/s1.jsonl", "workshop/builds/b1.json", "workshop/sessions/w1/session.json",
      ".stageflow/channel-sends.json", "identity/settings.json", "identity/consumer-identity.db", "manifest.json"]) {
      expect(names, keep).toContain(keep);
    }
    for (const gone of ["eval-engine", "eval-runs", "repos", "worktrees", "cache", "tmp", "backups", "restore-pending", "workshop/autosave", "host.lock", "host-id", "service.log", "agent/mcp-cache.json", "unknown-new-thing"]) {
      expect(names.some((name) => name === gone || name.startsWith(`${gone}/`)), gone).toBe(false);
    }
    for (const secret of ["agent/auth.json", "channel-secrets.json", "identity-secrets.json", "secrets/mcp-secrets.json", "secrets/mcp-oauth.key", "agent/mcp-oauth-encrypted", "agent/models.json"]) {
      expect(names, secret).not.toContain(secret);
    }
    const manifest = manifestOf(extract(result.path));
    expect(manifest.contains_secrets).toBe(false);
    expect(manifest.archive_version).toBe(1);
    expect(manifest.home_id).toBe("home-abc123");
    const leftOut = new Map(manifest.left_out.map((item) => [item.path, item.reason]));
    for (const secret of ["agent/", "secrets/", "channel-secrets.json", "identity-secrets.json"]) expect(leftOut.get(secret), secret).toMatch(/secrets are included only on request/);
    expect(leftOut.get("unknown-new-thing/")).toBe("not in the archive inventory");
    expect(leftOut.has("eval-engine/")).toBe(true);
    expect(statSync(result.path).mode & 0o777).toBe(0o600);
  });

  it("includes secrets, the paired OAuth files together, and marks the archive", async () => {
    const { home, store } = await makeHome();
    plant(home);
    const result = await buildArchive({ store: { snapshotInto: store.snapshotInto.bind(store), ...noRuns }, homeDir: home, includeSecrets: true });
    const names = listing(result.path);
    for (const secret of ["agent/auth.json", "channel-secrets.json", "identity-secrets.json", "secrets/mcp-secrets.json", "secrets/mcp-oauth.key", "agent/mcp-oauth-encrypted", "agent/models.json"]) {
      expect(names, secret).toContain(secret);
    }
    expect(result.contains_secrets).toBe(true);
    expect(manifestOf(extract(result.path)).contains_secrets).toBe(true);
  });

  it("leaves out an OAuth file whose pair is missing, even when secrets are included", async () => {
    const { home, store } = await makeHome();
    put(home, "secrets/mcp-oauth.key", "key");
    const result = await buildArchive({ store: { snapshotInto: store.snapshotInto.bind(store), ...noRuns }, homeDir: home, includeSecrets: true });
    expect(listing(result.path)).not.toContain("secrets/mcp-oauth.key");
    const manifest = manifestOf(extract(result.path));
    expect(manifest.left_out).toContainEqual({ path: "secrets/mcp-oauth.key", reason: "left out because its pair is missing" });
  });

  it("never lets a canary secret into the default archive, its manifest or the returned metadata", async () => {
    const { home, store } = await makeHome();
    plant(home);
    const result = await buildArchive({ store: { snapshotInto: store.snapshotInto.bind(store), ...noRuns }, homeDir: home });
    expect(gunzipSync(readFileSync(result.path)).includes(CANARY)).toBe(false);
    expect(JSON.stringify(result)).not.toContain(CANARY);
  });

  it("stores a symlink as a link and never follows it out of the data directory", async () => {
    const { home, store } = await makeHome();
    const outside = path.join(tmpdir(), `sf-outside-${Date.now()}.txt`);
    writeFileSync(outside, `outside ${CANARY}`);
    cleanups.push(async () => rm(outside, { force: true }));
    mkdirSync(path.join(home, "workspace"), { recursive: true });
    symlinkSync(outside, path.join(home, "workspace", "escape"));
    const result = await buildArchive({ store: { snapshotInto: store.snapshotInto.bind(store), ...noRuns }, homeDir: home });
    expect(gunzipSync(readFileSync(result.path)).includes(CANARY)).toBe(false);
    const dir = extract(result.path);
    expect(lstatSync(path.join(dir, "workspace", "escape")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(path.join(dir, "workspace", "escape"))).toBe(outside);
  });

  it("writes a manifest whose hashes match the extracted files", async () => {
    const { home, store } = await makeHome();
    plant(home);
    const result = await buildArchive({ store: { snapshotInto: store.snapshotInto.bind(store), ...noRuns }, homeDir: home });
    const dir = extract(result.path);
    const manifest = manifestOf(dir);
    const files = manifest.files.filter((file) => file.kind === "file");
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) {
      const bytes = readFileSync(path.join(dir, file.path));
      expect(bytes.length, file.path).toBe(file.size);
      expect(createHash("sha256").update(bytes).digest("hex"), file.path).toBe(file.sha256);
    }
  });

  it("round-trips long and non-ASCII names through a standard tar", async () => {
    const { home, store } = await makeHome();
    const long = `workspace/${"deep-folder-name/".repeat(8)}file-${"x".repeat(40)}.md`;
    const unicode = "workspace/héllo-世界.md";
    put(home, long, "long");
    put(home, unicode, "unicode");
    const result = await buildArchive({ store: { snapshotInto: store.snapshotInto.bind(store), ...noRuns }, homeDir: home });
    const dir = extract(result.path);
    expect(readFileSync(path.join(dir, long), "utf8")).toBe("long");
    expect(readFileSync(path.join(dir, unicode), "utf8")).toBe("unicode");
  });

  it("includes run files except agent directories, credentials and dependency folders", async () => {
    const { home, store } = await makeHome();
    const run = path.join(home, "runs", "run-1");
    put(home, "runs/run-1/stages/s1/attempts/1/artifacts/out.txt", "artifact");
    put(home, "runs/run-1/stages/s1/attempts/1/.pi-agent/auth.json", CANARY);
    put(home, "runs/run-1/stages/s1/attempts/1/node_modules/x/index.js", "dep");
    put(home, "runs/run-1/stages/s1/auth.json", CANARY);
    const fake = { snapshotInto: store.snapshotInto.bind(store), listRuns: async () => [{ run_id: "run-1" }] as never, getWorkspaceDir: () => run };
    const result = await buildArchive({ store: fake, homeDir: home });
    const names = listing(result.path);
    expect(names).toContain("runs/run-1/stages/s1/attempts/1/artifacts/out.txt");
    expect(names.some((name) => name.includes(".pi-agent") || name.includes("node_modules") || name.endsWith("auth.json"))).toBe(false);
    expect(gunzipSync(readFileSync(result.path)).includes(CANARY)).toBe(false);
    const manifest = manifestOf(extract(result.path));
    expect(manifest.left_out.some((item) => item.path.includes(".pi-agent"))).toBe(true);
  });

  it("refuses early when there is not enough free space, and leaves nothing behind", async () => {
    const { home, store } = await makeHome();
    plant(home);
    const out = path.join(home, "backups", "x.tar.gz");
    await expect(buildArchive({ store: { snapshotInto: store.snapshotInto.bind(store), ...noRuns }, homeDir: home, outPath: out, freeSpace: async () => ({ freeBytes: 10 }) })).rejects.toMatchObject({ code: "archive_insufficient_space" });
    expect(existsSync(out)).toBe(false);
    expect(existsSync(`${out}.partial`)).toBe(false);
  });

  it("refuses an output path under runs/ or worktrees/", async () => {
    const { home, store } = await makeHome();
    for (const bad of ["runs/x.tar.gz", "worktrees/x.tar.gz"]) {
      await expect(buildArchive({ store: { snapshotInto: store.snapshotInto.bind(store), ...noRuns }, homeDir: home, outPath: path.join(home, bad) })).rejects.toBeInstanceOf(ArchiveError);
    }
  });

  it("archives a 1 GB sparse file without growing memory by anything like its size", async () => {
    const { home, store } = await makeHome();
    const big = path.join(home, "workspace", "big.bin");
    mkdirSync(path.dirname(big), { recursive: true });
    writeFileSync(big, "");
    truncateSync(big, 1024 ** 3);
    const before = process.memoryUsage().rss;
    let peak = before;
    const timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 50);
    const result = await buildArchive({ store: { snapshotInto: store.snapshotInto.bind(store), ...noRuns }, homeDir: home });
    clearInterval(timer);
    expect(peak - before).toBeLessThan(300 * 1024 * 1024);
    expect(result.bytes).toBeLessThan(50 * 1024 * 1024);
    const manifest = manifestOf(extract(result.path));
    expect(manifest.files.find((file) => file.path === "workspace/big.bin")?.size).toBe(1024 ** 3);
  }, 120_000);
});

describe("the archive inventory and docs/data-directory.md", () => {
  it("has a rule for every path the layout table documents", () => {
    const doc = readFileSync(path.join(import.meta.dirname, "..", "docs", "data-directory.md"), "utf8");
    const table = doc.slice(doc.indexOf("## Layout"), doc.indexOf("### Workshop: builds and sessions"));
    const documented = table
      .split("\n")
      .filter((line) => line.startsWith("| `"))
      .map((line) => /^\| `([^`]+)`/.exec(line)![1]!)
      .map((cell) => cell.replace(/<[^>]*>.*$/, ""));
    expect(documented.length).toBeGreaterThan(25);
    const handledElsewhere = new Set(["runs/"]);
    const missing = documented.filter((entry) => !handledElsewhere.has(entry) && ruleFor(entry) === undefined && !ARCHIVE_RULES.some((rule) => rule.path.startsWith(entry)));
    expect(missing).toEqual([]);
    expect(ARCHIVE_RULES.length).toBeGreaterThan(25);
  });
});
