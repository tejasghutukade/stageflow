import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import { defaultSecretStore } from "../src/channels/registry.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { clearFindProjectRootCacheForTests } from "../src/project/findProjectRoot.js";
import { startTestService } from "./helpers/testInProcessService.js";
import { initTempGitRepo } from "./helpers/projectContext.js";
import { bindStageflowHomeForTests } from "./helpers/workspaceTestHarness.js";

const stageFixture = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "stages", "clarify.yaml");
const SECRET = "typed-in-console-secret-value";
const NEXT_SECRET = "replacement-console-secret-value";

function sign(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

async function seedCatalog(root: string): Promise<void> {
  for (const dir of ["pipelines", "stages", "tasks", "triggers"]) await mkdir(path.join(root, dir), { recursive: true });
  await writeFile(
    path.join(root, "stageflow.yaml"),
    "version: 1\ncatalog:\n  pipelines:\n    - pipelines\n  tasks:\n    - tasks\n  triggers:\n    - triggers\n",
  );
  await writeFile(path.join(root, "pipelines", "hello.pipeline.yaml"), "id: hello\nstages:\n  - id: clarify\n    uses: ../stages/clarify.yaml\n");
  await writeFile(path.join(root, "stages", "clarify.yaml"), await readFile(stageFixture, "utf8"));
  await writeFile(path.join(root, "tasks", "my-task.task.yaml"), "id: my-task\ngoal: Say hello\n");
}

const webhookEvent = { source: "webhook", config: { secretRef: "IGNORED", header: "x-signature" } };

async function withService(fn: (ctx: { root: string; url: string }) => Promise<void>): Promise<void> {
  const { root, cleanup } = await initTempGitRepo();
  try {
    await seedCatalog(root);
    clearFindProjectRootCacheForTests();
    const homeRoot = await mkdtemp(path.join(tmpdir(), "sf-trigger-secrets-"));
    bindStageflowHomeForTests(homeRoot);
    const store = createRunStore({ rootDir: homeRoot });
    await store.ensureProject(root);
    const service = await startTestService(store, scriptedFakeAgent([]), root);
    try {
      await fn({ root, url: service.baseUrl });
    } finally {
      await service.stop();
    }
  } finally {
    clearFindProjectRootCacheForTests();
    await cleanup();
  }
}

function send(url: string, method: string, body: unknown): Promise<Response> {
  return fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

describe("trigger secrets over the API", () => {
  it("create writes the store and only store:NAME to the file; the webhook then verifies", async () => {
    await withService(async ({ root, url }) => {
      const res = await send(`${url}/api/triggers`, "POST", {
        project_root: root, directory: "triggers", id: "hook", pipeline: "hello", task: "my-task",
        kind: "event", event: webhookEvent, secret: SECRET,
      });
      expect(res.status).toBe(201);
      const text = await res.text();
      expect(text).not.toContain(SECRET);
      const created = JSON.parse(text) as { secret_set: boolean; event: { config: { secretRef: string } } };
      expect(created.secret_set).toBe(true);
      expect(created.event.config.secretRef).toBe("store:trigger.hook.secret");

      const file = await readFile(path.join(root, "triggers", "hook.trigger.yaml"), "utf8");
      expect(file).toContain("secretRef: store:trigger.hook.secret");
      expect(file).not.toContain(SECRET);
      expect(defaultSecretStore().get("trigger.hook.secret")).toBe(SECRET);

      const list = await (await fetch(`${url}/api/triggers`)).text();
      expect(list).not.toContain(SECRET);
      expect(JSON.parse(list).triggers[0].secret_set).toBe(true);

      const body = JSON.stringify({ action: "opened" });
      const ok = await fetch(`${url}/api/triggers/hook/webhook`, { method: "POST", headers: { "x-signature": sign(SECRET, body) }, body });
      expect(ok.status).toBe(201);
      const bad = await fetch(`${url}/api/triggers/hook/webhook`, { method: "POST", headers: { "x-signature": sign("nope", body) }, body });
      expect(bad.status).toBe(401);
    });
  });

  it("edit replaces the secret, clear removes it and the webhook answers not configured", async () => {
    await withService(async ({ root, url }) => {
      await send(`${url}/api/triggers`, "POST", {
        project_root: root, directory: "triggers", id: "hook", pipeline: "hello", task: "my-task",
        kind: "event", event: webhookEvent, secret: SECRET,
      });
      const put = { project_root: root, pipeline: "hello", task: "my-task", kind: "event", enabled: true,
        event: { source: "webhook", config: { secretRef: "store:trigger.hook.secret", header: "x-signature" } } };

      const replaced = await send(`${url}/api/triggers/hook`, "PUT", { ...put, secret: NEXT_SECRET });
      expect(replaced.status).toBe(200);
      expect(await replaced.text()).not.toContain(NEXT_SECRET);
      expect(defaultSecretStore().get("trigger.hook.secret")).toBe(NEXT_SECRET);

      const cleared = await send(`${url}/api/triggers/hook`, "PUT", { ...put, clear_secret: true });
      expect(cleared.status).toBe(200);
      expect((await cleared.json()).secret_set).toBe(false);
      expect(defaultSecretStore().get("trigger.hook.secret")).toBeUndefined();
      const file = await readFile(path.join(root, "triggers", "hook.trigger.yaml"), "utf8");
      expect(file).toContain("store:trigger.hook.secret");

      const body = "{}";
      const res = await fetch(`${url}/api/triggers/hook/webhook`, { method: "POST", headers: { "x-signature": sign(NEXT_SECRET, body) }, body });
      expect(res.status).toBe(400);
    });
  });

  it("undoes the store write when the file change fails", async () => {
    await withService(async ({ root, url }) => {
      const create = { project_root: root, directory: "triggers", id: "hook", pipeline: "hello", task: "my-task", kind: "event", event: webhookEvent };
      expect((await send(`${url}/api/triggers`, "POST", { ...create, secret: SECRET })).status).toBe(201);

      const duplicate = await send(`${url}/api/triggers`, "POST", { ...create, secret: NEXT_SECRET });
      expect(duplicate.status).toBe(409);
      expect(defaultSecretStore().get("trigger.hook.secret")).toBe(SECRET);

      const dangling = await send(`${url}/api/triggers/hook`, "PUT", {
        project_root: root, pipeline: "missing", kind: "event", enabled: true, event: webhookEvent, secret: NEXT_SECRET,
      });
      expect(dangling.status).toBe(422);
      expect(defaultSecretStore().get("trigger.hook.secret")).toBe(SECRET);

      const fresh = await send(`${url}/api/triggers`, "POST", { ...create, id: "other", pipeline: "missing", secret: NEXT_SECRET });
      expect(fresh.status).toBe(422);
      expect(defaultSecretStore().get("trigger.other.secret")).toBeUndefined();
    });
  });

  it("rejects secrets for the wrong kind, bad combinations and a malformed store: name", async () => {
    await withService(async ({ root, url }) => {
      const base = { project_root: root, directory: "triggers", id: "m", pipeline: "hello", task: "my-task" };
      expect((await send(`${url}/api/triggers`, "POST", { ...base, kind: "manual", secret: SECRET })).status).toBe(400);
      expect((await send(`${url}/api/triggers`, "POST", { ...base, kind: "event", event: webhookEvent, clear_secret: true })).status).toBe(400);
      const malformed = await send(`${url}/api/triggers`, "POST", {
        ...base, kind: "event", event: { source: "webhook", config: { secretRef: "store:bad name!", header: "h" } },
      });
      expect(malformed.status).toBe(400);
      expect(defaultSecretStore().get("trigger.m.secret")).toBeUndefined();
    });
  });
});
