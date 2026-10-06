import { afterEach, describe, expect, it, vi } from "vitest";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse, stringify } from "yaml";
import { createA2aInvocations } from "../src/a2a/service.js";
import { loadPublicationRegistry } from "../src/a2a/registry.js";
import { RateLimiter } from "../src/a2a/limits.js";
import { createRunStoreWithConnection } from "../src/runstore/createStore.js";
import { RunManager } from "../src/runtime/runManager.js";
import { supplierAgent, gatedAgent } from "./fixtures/a2a/agents.js";

const env = { PROCUREMENT_TOKEN: "p".repeat(40), OTHER_TOKEN: "o".repeat(40) };
const caller = { id: "procurement" };
const roots: string[] = [];
afterEach(async () => {});

async function setup(configPath: string, agent = supplierAgent()) {
  const root = await mkdtemp(path.join(tmpdir(), "sf-a2a-invocations-"));
  roots.push(root);
  const { store, connection } = createRunStoreWithConnection({ rootDir: root });
  const manager = new RunManager({ agent, store, cwd: root });
  const registry = await loadPublicationRegistry(configPath, env);
  const invocations = createA2aInvocations(registry, manager, store, root, connection, new RateLimiter());
  return { invocations, manager };
}

function invoke(capability: string, input: unknown, messageId: string) {
  return {
    messageId,
    parts: [{ content: { $case: "data" as const, value: { contractVersion: 1, operation: "invoke", capability, input } } }],
  };
}

function answer(taskId: string, messageId: string, prompt: string, text: string) {
  return {
    messageId,
    taskId,
    parts: [{ content: { $case: "data" as const, value: { contractVersion: 1, operation: "answer", prompt, answer: { kind: "free_text", text } } } }],
  };
}

const supplierConfig = path.resolve("tests/fixtures/a2a/a2a.yaml");
const gatedConfig = path.resolve("tests/fixtures/a2a/gated.yaml");

describe("A2aInvocations (direct interface)", () => {
  it("runs invoke through clarify to a completed, frozen result", async () => {
    const { invocations } = await setup(supplierConfig);
    const submitted = await invocations.send(caller, invoke("supplier_assessment", { supplier: "Northstar" }, "m-1"));
    expect(["submitted", "working", "input-required"]).toContain(submitted.state);
    let task = submitted;
    for (let i = 0; i < 25 && task.state !== "input-required"; i += 1) {
      task = await invocations.get(caller, submitted.id);
    }
    expect(task.state).toBe("input-required");
    const handle = task.questions![0].handle;
    task = await invocations.send(caller, answer(submitted.id, "m-2", handle, "Yes."));
    for (let i = 0; i < 25 && task.state !== "completed"; i += 1) {
      task = await invocations.get(caller, submitted.id);
    }
    expect(task.state).toBe("completed");
    expect(task.result?.payload?.recommendation).toBe("approve");
    const listed = await invocations.list(caller, undefined);
    expect(listed.map((t) => t.id)).toContain(submitted.id);
  });

  it("rejects a fourth message once the admission cap and dedup rules are both exercised", async () => {
    const { invocations } = await setup(supplierConfig);
    const a = await invocations.send(caller, invoke("supplier_assessment", { supplier: "A" }, "m-a"));
    const b = await invocations.send(caller, invoke("supplier_assessment", { supplier: "B" }, "m-b"));
    expect(a.id).not.toBe(b.id);
    const replay = await invocations.send(caller, invoke("supplier_assessment", { supplier: "A" }, "m-a"));
    expect(replay.id).toBe(a.id);
    await expect(
      invocations.send(caller, invoke("supplier_assessment", { supplier: "different" }, "m-a")),
    ).rejects.toMatchObject({ category: "message-conflict" });
    await expect(
      invocations.send(caller, invoke("supplier_assessment", { supplier: "C" }, "m-c")),
    ).rejects.toMatchObject({ category: "busy" });
  });

  it("never resolves an operator-only gate through answer, and isolates tasks per caller", async () => {
    const { invocations } = await setup(gatedConfig, gatedAgent());
    const submitted = await invocations.send(caller, invoke("gated_capability", { note: "please" }, "m-1"));
    await expect(invocations.get({ id: "other" }, submitted.id)).rejects.toMatchObject({ category: "not-found" });
    const forgedHandle = Buffer.from([submitted.id, "approve", "whatever"].join(":"), "utf8").toString("base64url");
    await expect(
      invocations.send(caller, answer(submitted.id, "m-2", forgedHandle, "yes")),
    ).rejects.toMatchObject({ category: "stale-question" });
  });

  it("rejects unknown capabilities and schema-invalid input without starting a run", async () => {
    const { invocations, manager } = await setup(supplierConfig);
    await expect(invocations.send(caller, invoke("does_not_exist", {}, "m-1"))).rejects.toMatchObject({ category: "unknown-capability" });
    await expect(invocations.send(caller, invoke("supplier_assessment", {}, "m-2"))).rejects.toMatchObject({ category: "invalid-input" });
    expect(manager.getActiveCount()).toBe(0);
  });

  it("forwards publication repository/ref onto the inline start task (U7)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-a2a-u7-"));
    roots.push(root);
    await cp(path.resolve("tests/fixtures/a2a"), root, { recursive: true });
    const configPath = path.join(root, "a2a.yaml");
    const config = parse(await readFile(configPath, "utf8"));
    config.publications[0].repository = "acme/api";
    config.publications[0].ref = "main";
    await writeFile(configPath, stringify(config));

    const { store, connection } = createRunStoreWithConnection({ rootDir: root });
    const manager = new RunManager({ agent: supplierAgent(), store, cwd: root });
    const spy = vi.spyOn(manager, "startRunOnce").mockResolvedValue({
      ok: false,
      reason: "stopped for assertion",
      status: 500,
    });
    const registry = await loadPublicationRegistry(configPath, env);
    const invocations = createA2aInvocations(
      registry,
      manager,
      store,
      root,
      connection,
      new RateLimiter(),
    );
    await expect(
      invocations.send(caller, invoke("supplier_assessment", { supplier: "Northstar" }, "m-u7")),
    ).rejects.toBeTruthy();
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          repository: "acme/api",
          ref: "main",
          goal: "Produce an evidence-backed supplier assessment.",
        }),
      }),
      expect.any(Object),
    );
    spy.mockRestore();
  });
});
