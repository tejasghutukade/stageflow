import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLocalAuditSink, localAuditLogPath } from "../src/browser/auditSink.js";
import { createLocalKeyProvider, localKeyFilePath } from "../src/browser/keyProvider.js";
import { createLocalProfileStore } from "../src/browser/localProfileStore.js";
import { auditStageNavigations } from "../src/browser/navigationAudit.js";
import { LOCAL_BROWSER_SCOPE } from "../src/browser/profileStore.js";
import { assertBrowserSitesAllowed, BlockedSiteError } from "../src/browser/sitePolicy.js";
import { loadHostConfig } from "../src/config/hostConfig.js";
import { resetGlobalStageflowHomeForTests } from "../src/project/globalHome.js";
import { writeFile } from "node:fs/promises";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "sf-audit-"));
  process.env.STAGEFLOW_HOME = home;
  resetGlobalStageflowHomeForTests();
});
afterEach(async () => {
  resetGlobalStageflowHomeForTests();
  delete process.env.STAGEFLOW_HOME;
  await rm(home, { recursive: true, force: true });
});

async function auditLines(): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(localAuditLogPath(), "utf8");
  return text.trim().split("\n").map((l) => JSON.parse(l));
}

describe("profile store audit", () => {
  it("records created once and deleted, with names only", async () => {
    const store = createLocalProfileStore();
    const key = { scope: LOCAL_BROWSER_SCOPE, name: "acct" };
    await store.open(key);
    await store.open(key);
    await store.delete(key);
    await store.delete(key);
    const lines = await auditLines();
    expect(lines.map((l) => l.event)).toEqual(["profile_created", "profile_deleted"]);
    expect(lines[0]).toMatchObject({ scope: "local", profile: "acct" });
    expect(JSON.stringify(lines)).not.toContain(home);
    expect((await stat(localAuditLogPath())).mode & 0o777).toBe(0o600);
  });

  it("accepts an injected sink", async () => {
    const file = path.join(home, "custom.jsonl");
    const store = createLocalProfileStore({ audit: createLocalAuditSink(file) });
    await store.open({ scope: LOCAL_BROWSER_SCOPE, name: "x1" });
    expect(await readFile(file, "utf8")).toContain("profile_created");
  });
});

describe("key provider", () => {
  it("creates a 0600 key file on demand and returns the same key", async () => {
    const provider = createLocalKeyProvider();
    const key = await provider.getKey();
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect((await stat(localKeyFilePath())).mode & 0o777).toBe(0o600);
    expect(await createLocalKeyProvider().getKey()).toBe(key);
  });
});

describe("Host site policy", () => {
  it("blocks allow_domains and check urls on blocked sites incl. subdomains", () => {
    const blocked = ["linkedin.com"];
    expect(() => assertBrowserSitesAllowed("s", { allow_domains: ["www.linkedin.com"] }, blocked)).toThrow(BlockedSiteError);
    expect(() => assertBrowserSitesAllowed("s", { allow_domains: ["*.linkedin.com"] }, blocked)).toThrow(/blocked by Host policy/);
    expect(() => assertBrowserSitesAllowed("s", { check: { url: "https://www.linkedin.com/feed" } }, blocked)).toThrow(/linkedin\.com/);
    expect(() => assertBrowserSitesAllowed("s", { allow_domains: ["notlinkedin.com", "example.com"] }, blocked)).not.toThrow();
    expect(() => assertBrowserSitesAllowed("s", { allow_domains: ["linkedin.com"] }, [])).not.toThrow();
  });

  it("blocks a login_url on a blocked site", () => {
    const blocked = ["linkedin.com"];
    expect(() => assertBrowserSitesAllowed("s", { login_url: "https://www.linkedin.com/login" }, blocked)).toThrow(
      /Stage "s".*login_url.*linkedin\.com.*blocked by Host policy \(browser\.blocked_sites\)/,
    );
    expect(() => assertBrowserSitesAllowed("s", { login_url: "https://ok.example/login" }, blocked)).not.toThrow();
  });

  it("loads browser.blocked_sites from host config", async () => {
    const file = path.join(home, "config.yaml");
    await writeFile(file, "browser:\n  blocked_sites:\n    - LinkedIn.com\n    - '*.bank.example'\n");
    expect(loadHostConfig({ env: {}, homeDir: home }).browserBlockedSites).toEqual(["linkedin.com", "bank.example"]);
    await writeFile(file, "browser:\n  nope: 1\n");
    expect(() => loadHostConfig({ env: {}, homeDir: home })).toThrow(/Unknown key/);
    expect(loadHostConfig({ env: {}, homeDir: home, configFilePath: null }).browserBlockedSites).toEqual([]);
  });
});

describe("soft navigation audit", () => {
  const policy = { runId: "r1", stageId: "s1", profile: "acct", allow_domains: ["example.com"] };
  const tool = (cmd: string) => ({ event: "tool_start" as const, toolName: "bash", argsPreview: cmd });

  it("records hosts outside the allowlist, never full urls", async () => {
    const records: unknown[] = [];
    await auditStageNavigations(
      policy,
      async () => [
        tool("agent-browser open https://www.example.com/a"),
        tool("agent-browser open 'https://evil.test/path?token=abc'"),
        tool("agent-browser goto evil.test"),
      ],
      { record: async (r) => void records.push(r) },
    );
    expect(records).toEqual([
      expect.objectContaining({ event: "navigation_outside_allowlist", host: "evil.test", runId: "r1", stageId: "s1" }),
    ]);
    expect(JSON.stringify(records)).not.toContain("token=abc");
  });

  it("warns when the activity log is unavailable", async () => {
    const records: unknown[] = [];
    await auditStageNavigations(policy, undefined, { record: async (r) => void records.push(r) });
    expect(records).toEqual([expect.objectContaining({ event: "allowlist_unverified" })]);
  });
});
