import { execFileSync } from "node:child_process";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import {
  DEFAULT_DIFF_MAX_BYTES,
  getRunDiff,
  listCheckoutChanges,
  parseStatusPorcelainZ,
  readCheckoutFileBytes,
} from "../src/mcp/checkoutTools.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { startUiServer } from "../src/server/http.js";
import { mcpCall } from "./helpers/mcpCall.js";
import { FIXTURES_ROOT } from "./helpers/fixturePaths.js";

const temps: string[] = [];

afterEach(async () => {
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  }).trim();
}

async function makeGitCheckout(): Promise<{ root: string; sha: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "sf-u8-git-"));
  temps.push(root);
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test"]);
  await writeFile(path.join(root, "README"), "hello\n");
  git(root, ["add", "README"]);
  git(root, ["commit", "-m", "init"]);
  const sha = git(root, ["rev-parse", "HEAD"]);
  return { root, sha };
}

describe("parseStatusPorcelainZ", () => {
  it("maps untracked modified deleted and added", () => {
    expect(
      parseStatusPorcelainZ(" M tracked.txt\0?? new.txt\0 D gone.txt\0A  staged.txt\0"),
    ).toEqual([
      { path: "tracked.txt", status: "modified" },
      { path: "new.txt", status: "untracked" },
      { path: "gone.txt", status: "deleted" },
      { path: "staged.txt", status: "added" },
    ]);
  });
});

describe("checkout visibility tools (U8)", () => {
  it("lists changes, stat/patch diffs, and reads files for a repository binding", async () => {
    const { root: checkout, sha } = await makeGitCheckout();
    await writeFile(path.join(checkout, "README"), "changed\n");
    await writeFile(path.join(checkout, "extra.txt"), "new\n");

    const storeRoot = await mkdtemp(path.join(tmpdir(), "sf-u8-store-"));
    temps.push(storeRoot);
    const store = createRunStore({ rootDir: storeRoot });
    const created = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: g\nrepository: acme/api\nref: main\n",
      taskId: "t",
      repository: "acme/api",
      ref: "main",
      resolvedSha: sha,
      runBranch: "stageflow/run-test",
      checkoutRoot: checkout,
    });

    const changes = await listCheckoutChanges(store, created.runId);
    expect(changes.ok).toBe(true);
    if (!changes.ok) return;
    expect(changes.truncated).toBe(false);
    expect(changes.changes).toEqual(
      expect.arrayContaining([
        { path: "README", status: "modified" },
        { path: "extra.txt", status: "untracked" },
      ]),
    );

    const stat = await getRunDiff(store, created.runId, { mode: "stat" });
    expect(stat.ok).toBe(true);
    if (!stat.ok) return;
    expect(stat.base_sha).toBe(sha);
    expect(stat.base_source).toBe("resolved_sha");
    expect(stat.content).toMatch(/README/);
    expect(stat.untracked).toContain("extra.txt");
    expect(stat.truncated).toBe(false);

    const patch = await getRunDiff(store, created.runId, { mode: "patch" });
    expect(patch.ok).toBe(true);
    if (!patch.ok) return;
    expect(patch.content).toMatch(/diff --git/);
    expect(patch.content).toMatch(/changed/);

    const file = await readCheckoutFileBytes(store, created.runId, "extra.txt");
    expect(file.ok).toBe(true);
    if (!file.ok) return;
    expect(file.bytes.toString("utf8")).toBe("new\n");

    expect(process.env.GIT_ASKPASS).toBeUndefined();
  });

  it("returns run_not_bound for unbound runs", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "sf-u8-unbound-"));
    temps.push(storeRoot);
    const store = createRunStore({ rootDir: storeRoot });
    const created = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: a\ngoal: g\n",
      taskId: "a",
    });
    const result = await listCheckoutChanges(store, created.runId);
    expect(result).toMatchObject({
      ok: false,
      code: "run_not_bound",
    });
  });

  it("returns not_a_git_repository for non-git path checkout diffs", async () => {
    const checkout = await mkdtemp(path.join(tmpdir(), "sf-u8-nongit-"));
    temps.push(checkout);
    await writeFile(path.join(checkout, "note.txt"), "plain\n");

    const storeRoot = await mkdtemp(path.join(tmpdir(), "sf-u8-nongit-store-"));
    temps.push(storeRoot);
    const store = createRunStore({ rootDir: storeRoot });
    const created = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: a\ngoal: g\n",
      taskId: "a",
      checkoutRoot: checkout,
    });

    const changes = await listCheckoutChanges(store, created.runId);
    expect(changes.ok).toBe(true);
    if (!changes.ok) return;
    expect(changes.changes).toEqual([
      { path: "note.txt", status: "untracked" },
    ]);

    const diffResult = await getRunDiff(store, created.runId);
    expect(diffResult).toMatchObject({
      ok: false,
      code: "not_a_git_repository",
    });
  });

  it("returns checkout_reclaimed when checkout_root is missing", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "sf-u8-reclaimed-"));
    temps.push(storeRoot);
    const store = createRunStore({ rootDir: storeRoot });
    const created = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: a\ngoal: g\n",
      taskId: "a",
      checkoutRoot: path.join(storeRoot, "gone-checkout"),
    });
    const result = await listCheckoutChanges(store, created.runId);
    expect(result).toMatchObject({
      ok: false,
      code: "checkout_reclaimed",
    });
  });

  it("denies symlink escape, .pi-agent, and auth.json", async () => {
    const outside = await mkdtemp(path.join(tmpdir(), "sf-u8-out-"));
    temps.push(outside);
    await writeFile(path.join(outside, "secret.txt"), "nope\n");

    const checkout = await mkdtemp(path.join(tmpdir(), "sf-u8-deny-"));
    temps.push(checkout);
    symlinkSync(path.join(outside, "secret.txt"), path.join(checkout, "escape.txt"));
    mkdirSync(path.join(checkout, ".pi-agent"), { recursive: true });
    writeFileSync(path.join(checkout, ".pi-agent", "session.json"), "{}");
    writeFileSync(path.join(checkout, "auth.json"), '{"token":1}');
    writeFileSync(path.join(checkout, "ok.txt"), "ok\n");

    const storeRoot = await mkdtemp(path.join(tmpdir(), "sf-u8-deny-store-"));
    temps.push(storeRoot);
    const store = createRunStore({ rootDir: storeRoot });
    const created = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: a\ngoal: g\n",
      taskId: "a",
      checkoutRoot: checkout,
    });

    await expect(
      readCheckoutFileBytes(store, created.runId, "escape.txt"),
    ).rejects.toThrow(/escapes the checkout/);
    await expect(
      readCheckoutFileBytes(store, created.runId, ".pi-agent/session.json"),
    ).rejects.toThrow(/Artifact path denied/);
    await expect(
      readCheckoutFileBytes(store, created.runId, "auth.json"),
    ).rejects.toThrow(/Artifact path denied/);

    const ok = await readCheckoutFileBytes(store, created.runId, "ok.txt");
    expect(ok.ok).toBe(true);
  });

  it("sets truncated true when patch exceeds maxBytes", async () => {
    const { root: checkout, sha } = await makeGitCheckout();
    const big = `${"x".repeat(4000)}\n`;
    await writeFile(path.join(checkout, "README"), big);

    const storeRoot = await mkdtemp(path.join(tmpdir(), "sf-u8-trunc-"));
    temps.push(storeRoot);
    const store = createRunStore({ rootDir: storeRoot });
    const created = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: g\n",
      taskId: "t",
      repository: "acme/api",
      ref: "main",
      resolvedSha: sha,
      checkoutRoot: checkout,
    });

    const patch = await getRunDiff(store, created.runId, {
      mode: "patch",
      maxBytes: 64,
    });
    expect(patch.ok).toBe(true);
    if (!patch.ok) return;
    expect(patch.truncated).toBe(true);
    expect(patch.content.length).toBe(64);
    expect(DEFAULT_DIFF_MAX_BYTES).toBe(262_144);
  });

  it("MCP and REST share change vocabulary", async () => {
    const { root: checkout, sha } = await makeGitCheckout();
    await writeFile(path.join(checkout, "README"), "edited\n");
    await writeFile(path.join(checkout, "fresh.txt"), "fresh\n");

    const storeRoot = await mkdtemp(path.join(tmpdir(), "sf-u8-http-"));
    temps.push(storeRoot);
    const store = createRunStore({ rootDir: storeRoot });
    const created = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: g\n",
      taskId: "t",
      repository: "acme/api",
      ref: "main",
      resolvedSha: sha,
      runBranch: "stageflow/run-u8",
      checkoutRoot: checkout,
    });

    const agent = scriptedFakeAgent([]);
    const started = await startUiServer({
      agent,
      cwd: FIXTURES_ROOT,
      rootDir: storeRoot,
      store,
      port: 0,
      uiDistDir: path.join(storeRoot, "missing-ui"),
      mcpStateless: true,
    });
    const address = started.server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected TCP address");
    }
    const base = `http://127.0.0.1:${address.port}`;

    try {
      const mcpChanges = await mcpCall(base, "list_checkout_changes", {
        runId: created.runId,
      });
      expect(mcpChanges.isError).toBe(false);
      expect(mcpChanges.payload.changes).toEqual(
        expect.arrayContaining([
          { path: "README", status: "modified" },
          { path: "fresh.txt", status: "untracked" },
        ]),
      );

      const restChanges = await fetch(
        `${base}/api/runs/${encodeURIComponent(created.runId)}/changes`,
      );
      expect(restChanges.status).toBe(200);
      const restBody = (await restChanges.json()) as {
        changes: Array<{ path: string; status: string }>;
      };
      expect(restBody.changes).toEqual(mcpChanges.payload.changes);

      const mcpDiff = await mcpCall(base, "get_run_diff", {
        runId: created.runId,
        mode: "stat",
      });
      expect(mcpDiff.isError).toBe(false);
      expect(mcpDiff.payload.base_sha).toBe(sha);

      const restDiff = await fetch(
        `${base}/api/runs/${encodeURIComponent(created.runId)}/diff?mode=stat`,
      );
      expect(restDiff.status).toBe(200);
      const diffBody = (await restDiff.json()) as { base_sha: string };
      expect(diffBody.base_sha).toBe(sha);

      const mcpFile = await mcpCall(base, "read_checkout_file", {
        runId: created.runId,
        path: "fresh.txt",
      });
      expect(mcpFile.isError).toBe(false);
      expect(mcpFile.payload.content).toBe("fresh\n");

      const restFile = await fetch(
        `${base}/api/runs/${encodeURIComponent(created.runId)}/file?path=${encodeURIComponent("fresh.txt")}`,
      );
      expect(restFile.status).toBe(200);
      expect(await restFile.text()).toBe("fresh\n");

      const unbound = await store.createRun({
        pipelineId: "docs-only",
        taskYaml: "id: u\ngoal: g\n",
        taskId: "u",
      });
      const mcpUnbound = await mcpCall(base, "list_checkout_changes", {
        runId: unbound.runId,
      });
      expect(mcpUnbound.isError).toBe(true);
      expect(mcpUnbound.payload.code).toBe("run_not_bound");

      const restUnbound = await fetch(
        `${base}/api/runs/${encodeURIComponent(unbound.runId)}/changes`,
      );
      expect(restUnbound.status).toBe(400);
      expect((await restUnbound.json()).code).toBe("run_not_bound");
    } finally {
      await new Promise<void>((resolve, reject) => {
        started.server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });
});
