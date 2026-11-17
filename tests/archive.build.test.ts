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
import { ConsumerIdentityStore } from "../src/identity/store.js";
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

  it("keeps people and revocations in the identity database and removes its client secrets unless secrets are included", async () => {
    const { home, store } = await makeHome();
    const identityPath = path.join(home, "identity", "consumer-identity.db");
    mkdirSync(path.dirname(identityPath), { recursive: true });
    const clientSecret = `oidc-client-${CANARY}`;
    const refresh = `refresh-${CANARY}`;
    const live = new ConsumerIdentityStore(identityPath, "local");
    live.registerOidc({ id: "directory", issuer: "https://login.example.com", clientId: "orders-app", agentId: "support", redirectUri: "https://chat.example/api/public/chat/slug/oidc/callback", algorithms: ["ES256"] }, clientSecret);
    const permission = { scope: "own" as const, agents: ["support"], actions: ["conversation:use" as const, "order:read" as const] };
    live.assign("directory", "alice", "acct-alice", "business-directory:v1", permission);
    const bob = live.assign("directory", "bob", "acct-bob", "business-directory:v1", permission);
    live.revoke("principal", bob);
    live.close();
    const raw = new Database(identityPath);
    raw.prepare("INSERT INTO identity_sessions(workspace, id, principal, agent, expires, principal_revision, active, refresh_secret) SELECT 'local', 'ses1', id, 'support', 9999999999999, revision, 1, ? FROM identity_principals WHERE subject = 'alice'").run(refresh);
    raw.close();

    const build = (includeSecrets: boolean) => buildArchive({ store: { snapshotInto: store.snapshotInto.bind(store), ...noRuns }, homeDir: home, includeSecrets, outPath: path.join(home, "backups", `identity-${includeSecrets}.tar.gz`) });
    const plain = await build(false);
    const dir = extract(plain.path);
    const copyPath = path.join(dir, "identity", "consumer-identity.db");
    expect(readFileSync(copyPath).includes(CANARY)).toBe(false);
    expect(manifestOf(dir).files.find((file) => file.path === "identity/consumer-identity.db")?.note).toMatch(/client secrets and refresh tokens removed/);
    const copy = new ConsumerIdentityStore(copyPath, "local");
    expect(copy.listAssignments().map((row) => [row.subject, row.accountId, row.active])).toEqual([["alice", "acct-alice", true], ["bob", "acct-bob", false]]);
    expect(() => copy.oidcClientSecret("directory")).toThrow("identity.setup_required");
    expect(copy.oidcSetup("directory").clientId).toBe("orders-app");
    copy.close();
    expect(() => new ConsumerIdentityStore(copyPath, "another-workspace")).toThrow(/another Workspace/);
    // The live database is untouched.
    const still = new ConsumerIdentityStore(identityPath, "local");
    expect(still.oidcClientSecret("directory")).toBe(clientSecret);
    still.close();

    const full = await build(true);
    const fullDir = extract(full.path);
    expect(manifestOf(fullDir).contains_secrets).toBe(true);
    const kept = new ConsumerIdentityStore(path.join(fullDir, "identity", "consumer-identity.db"), "local");
    expect(kept.oidcClientSecret("directory")).toBe(clientSecret);
    expect(kept.refreshSecret("ses1")).toBe(refresh);
    kept.close();
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

  it("words a refused output path as archive_out_denied, not as a backup error", async () => {
    const { home, store } = await makeHome();
    const attempt = buildArchive({ store: { snapshotInto: store.snapshotInto.bind(store), ...noRuns }, homeDir: home, outPath: path.join(home, "runs", "x.tar.gz") });
    await expect(attempt).rejects.toMatchObject({ code: "archive_out_denied", message: "archive_out_denied: refusing to write under worktrees/ or runs/" });
    await expect(buildArchive({ store: { snapshotInto: store.snapshotInto.bind(store), ...noRuns }, homeDir: home, outPath: `${home}/backups/../x.tar.gz` }))
      .rejects.toMatchObject({ code: "archive_out_denied", message: "archive_out_denied: path must not contain .. segments" });
  });

  it("streams the manifest to disk in the same layout as a pretty-printed object, for a tree of thousands of files", async () => {
    const { home, store } = await makeHome();
    plant(home);
    for (let i = 0; i < 2500; i++) put(home, `memories/bulk/f${i}.md`, `file ${i}`);
    const result = await buildArchive({ store: { snapshotInto: store.snapshotInto.bind(store), ...noRuns }, homeDir: home });
    const dir = extract(result.path);
    const text = readFileSync(path.join(dir, "manifest.json"), "utf8");
    const manifest = JSON.parse(text) as ArchiveManifest;
    expect(text).toBe(`${JSON.stringify(manifest, null, 2)}\n`);
    expect(Object.keys(manifest)).toEqual(["archive_version", "stageflow_version", "created_at", "contains_secrets", "home_id", "store_schema_version", "files", "left_out"]);
    expect(manifest.files.length).toBe(result.file_count);
    const bulk = manifest.files.filter((file) => file.path.startsWith("memories/bulk/"));
    expect(bulk).toHaveLength(2500);
    for (const file of bulk.slice(0, 50)) expect(file.sha256).toBe(createHash("sha256").update(readFileSync(path.join(dir, file.path))).digest("hex"));
    const members = listing(result.path).filter((name) => name !== ".stageflow-archive" && name !== "manifest.json" && !name.endsWith("/"));
    expect(new Set(manifest.files.filter((file) => file.kind === "file").map((file) => file.path))).toEqual(new Set(members));
  });

  it("reports the sha256 of the archive file it wrote", async () => {
    const { home, store } = await makeHome();
    plant(home);
    const result = await buildArchive({ store: { snapshotInto: store.snapshotInto.bind(store), ...noRuns }, homeDir: home });
    expect(result.sha256).toBe(createHash("sha256").update(readFileSync(result.path)).digest("hex"));
    expect(result.bytes).toBe(statSync(result.path).size);
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

describe("agent/models.json", () => {
  const MODELS = {
    providers: {
      openrouter: {
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: CANARY,
        headers: { Authorization: `Bearer ${CANARY}`, "X-Title": "Stageflow" },
        openRouterRouting: { only: ["deepinfra"], allow_fallbacks: false },
        models: [{ id: "deepseek/deepseek-v3", maxTokens: 8192, contextWindow: 65536, accessToken: CANARY }],
      },
    },
  };

  it("keeps the routing and drops keys and headers from a default archive", async () => {
    const { home, store } = await makeHome();
    put(home, "agent/models.json", JSON.stringify(MODELS));
    const result = await buildArchive({ store: { snapshotInto: store.snapshotInto.bind(store), ...noRuns }, homeDir: home });
    const dir = extract(result.path);
    const kept = JSON.parse(readFileSync(path.join(dir, "agent", "models.json"), "utf8")) as typeof MODELS;
    const openrouter = kept.providers.openrouter as Record<string, unknown>;
    expect(openrouter.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(openrouter.openRouterRouting).toEqual({ only: ["deepinfra"], allow_fallbacks: false });
    expect(openrouter.models).toEqual([{ id: "deepseek/deepseek-v3", maxTokens: 8192, contextWindow: 65536 }]);
    expect(openrouter).not.toHaveProperty("apiKey");
    expect(openrouter).not.toHaveProperty("headers");
    expect(gunzipSync(readFileSync(result.path)).includes(CANARY)).toBe(false);
    const manifest = manifestOf(dir);
    expect(manifest.files.find((file) => file.path === "agent/models.json")).toMatchObject({ kind: "file", note: "keys and headers removed" });
    expect(manifest.contains_secrets).toBe(false);
    expect(result.contains_secrets).toBe(false);
  });

  it("copies the file as it is, and marks the archive, when secrets are included", async () => {
    const { home, store } = await makeHome();
    put(home, "agent/models.json", JSON.stringify(MODELS));
    const result = await buildArchive({ store: { snapshotInto: store.snapshotInto.bind(store), ...noRuns }, homeDir: home, includeSecrets: true });
    const dir = extract(result.path);
    expect(JSON.parse(readFileSync(path.join(dir, "agent", "models.json"), "utf8"))).toEqual(MODELS);
    expect(result.contains_secrets).toBe(true);
    expect(manifestOf(dir).files.find((file) => file.path === "agent/models.json")).not.toHaveProperty("note");
  });

  it("leaves out a models.json it cannot read as JSON, and says why", async () => {
    const { home, store } = await makeHome();
    put(home, "agent/models.json", `{ not json ${CANARY}`);
    const result = await buildArchive({ store: { snapshotInto: store.snapshotInto.bind(store), ...noRuns }, homeDir: home });
    expect(listing(result.path)).not.toContain("agent/models.json");
    expect(gunzipSync(readFileSync(result.path)).includes(CANARY)).toBe(false);
    const leftOut = manifestOf(extract(result.path)).left_out.find((item) => item.path === "agent/models.json");
    expect(leftOut?.reason).toMatch(/not valid JSON/);
  });
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
