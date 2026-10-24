import { describe, expect, it } from "vitest";
import { WORKING_STATE_TOOL_NAME } from "../src/compaction/types.js";
import {
  WORKING_STATE_CUSTOM_TYPE,
  WorkingStateStore,
  restoreWorkingState,
  type WorkingStateEvent,
} from "../src/compaction/workingState.js";
import { createWorkingStateExtension, createWorkingStateTool } from "../src/tools/workingState.js";

function setup() {
  const store = new WorkingStateStore();
  const events: WorkingStateEvent[] = [];
  const tool = createWorkingStateTool({ store, persist: (e) => events.push(e), now: () => "t" });
  const run = (input: unknown) => tool.execute("id", input);
  return { store, events, tool, run };
}
const text = (r: { content: { text: string }[] }) => r.content[0]!.text;

describe("working_state tool", () => {
  it("uses the shared tool name and a usage-oriented description", () => {
    const { tool } = setup();
    expect(tool.name).toBe(WORKING_STATE_TOOL_NAME);
    expect(tool.description).toMatch(/trimmed/);
  });

  it("sets, updates, lists and deletes, persisting each change", async () => {
    const { run, events, store } = setup();
    expect(text(await run({ operation: "set", key: "id", kind: "fact", value: "INC-1" }))).toMatch(/^Saved id/);
    expect(text(await run({ operation: "set", key: "id", kind: "fact", value: "INC-2" }))).toMatch(/^Updated id/);
    expect(text(await run({ operation: "list" }))).toContain("- id: INC-2");
    expect(text(await run({ operation: "delete", key: "id" }))).toMatch(/Deleted/);
    expect(store.size).toBe(0);
    expect(events.map((e) => e.op)).toEqual(["set", "set", "delete"]);
    expect(text(await run({ operation: "list" }))).toBe("Working state is empty.");
  });

  it("returns error results for bad input and does not persist", async () => {
    const { run, events } = setup();
    for (const input of [
      { operation: "set", key: "k", kind: "fact" },
      { operation: "set", key: "k", kind: "bad", value: "v" },
      { operation: "delete" },
      { operation: "delete", key: "missing" },
      { operation: "nope" },
    ]) {
      const r = (await run(input)) as { isError?: boolean };
      expect(r.isError).toBe(true);
    }
    expect(events).toHaveLength(0);
  });

  it("tells the model what was dropped when full", async () => {
    const { run } = setup();
    for (let i = 0; i < 60; i++) await run({ operation: "set", key: `p${i}`, kind: "progress", value: "x" });
    expect(text(await run({ operation: "set", key: "n", kind: "todo", value: "x" }))).toContain("dropped oldest progress: p0");
  });

  it("round-trips through persisted events", async () => {
    const { run, events, store } = setup();
    await run({ operation: "set", key: "a", kind: "decision", value: "go" });
    await run({ operation: "set", key: "b", kind: "todo", value: "later" });
    await run({ operation: "delete", key: "b" });
    const entries = events.map((data) => ({ type: "custom", customType: WORKING_STATE_CUSTOM_TYPE, data }));
    expect(restoreWorkingState(entries).list()).toEqual(store.list());
  });
});

describe("createWorkingStateExtension", () => {
  it("registers the tool, restores from the session on first use and appends entries", async () => {
    const appended: unknown[] = [];
    let registered: any;
    const api = {
      registerTool: (t: unknown) => (registered = t),
      appendEntry: (type: string, data: unknown) => appended.push([type, data]),
    };
    await createWorkingStateExtension()(api as never);
    expect(registered.name).toBe(WORKING_STATE_TOOL_NAME);
    const prior = [
      { type: "custom", customType: WORKING_STATE_CUSTOM_TYPE, data: { op: "set", key: "old", kind: "fact", value: "v", at: "t" } },
    ];
    const ctx = { sessionManager: { getEntries: () => prior } };
    const listed = await registered.execute("1", { operation: "list" }, undefined, undefined, ctx);
    expect(listed.content[0].text).toContain("- old: v");
    await registered.execute("2", { operation: "set", key: "n", kind: "todo", value: "x" }, undefined, undefined, ctx);
    expect(appended).toHaveLength(1);
    expect((appended[0] as unknown[])[0]).toBe(WORKING_STATE_CUSTOM_TYPE);
  });
});
