import { describe, expect, it } from "vitest";
import {
  WORKING_STATE_CUSTOM_TYPE,
  WORKING_STATE_MAX_ENTRIES,
  WORKING_STATE_MAX_KEY,
  WORKING_STATE_MAX_VALUE,
  WorkingStateStore,
  getWorkingStateSections,
  reduceWorkingState,
  restoreWorkingState,
  type WorkingStateEvent,
} from "../src/compaction/workingState.js";

const at = "2026-01-01T00:00:00Z";

describe("WorkingStateStore", () => {
  it("deletes an entry whose key was altered by scrubbing", () => {
    const s = new WorkingStateStore();
    const key = "Authorization: Bearer abcdefghijklmnop1234";
    const set = s.set({ key, kind: "fact", value: "x" });
    expect(set.ok && set.redacted).toBe(true);
    expect(s.delete(key)).toBe(true);
    expect(s.size).toBe(0);
  });

  it("sets, replaces, deletes and lists", () => {
    const s = new WorkingStateStore();
    expect(s.set({ key: "a", kind: "fact", value: "1" })).toMatchObject({ ok: true, replaced: false });
    expect(s.set({ key: "a", kind: "fact", value: "2" })).toMatchObject({ ok: true, replaced: true });
    expect(s.list()).toHaveLength(1);
    expect(s.list()[0]!.value).toBe("2");
    expect(s.delete("a")).toBe(true);
    expect(s.delete("a")).toBe(false);
  });

  it("validates input", () => {
    const s = new WorkingStateStore();
    expect(s.set({ key: "", kind: "fact", value: "x" }).ok).toBe(false);
    expect(s.set({ key: "k", kind: "fact", value: "" }).ok).toBe(false);
    expect(s.set({ key: "k", kind: "nope" as never, value: "x" }).ok).toBe(false);
    expect(s.set({ key: "k".repeat(WORKING_STATE_MAX_KEY + 1), kind: "fact", value: "x" }).ok).toBe(false);
    expect(s.set({ key: "k", kind: "fact", value: "v".repeat(WORKING_STATE_MAX_VALUE + 1) }).ok).toBe(false);
    expect(s.set({ key: "k", kind: "fact", value: "v".repeat(WORKING_STATE_MAX_VALUE) }).ok).toBe(true);
  });

  it("evicts the oldest progress entries when full", () => {
    const s = new WorkingStateStore();
    s.set({ key: "p0", kind: "progress", value: "x" });
    s.set({ key: "f0", kind: "fact", value: "x" });
    for (let i = 1; i < WORKING_STATE_MAX_ENTRIES - 1; i++) {
      s.set({ key: `p${i}`, kind: "progress", value: "x" });
    }
    expect(s.size).toBe(WORKING_STATE_MAX_ENTRIES);
    const r = s.set({ key: "new", kind: "todo", value: "x" });
    expect(r).toMatchObject({ ok: true, dropped: ["p0"] });
    expect(s.size).toBe(WORKING_STATE_MAX_ENTRIES);
    expect(s.list().some((e) => e.key === "f0")).toBe(true);
  });

  it("rejects when full of non-progress entries", () => {
    const s = new WorkingStateStore();
    for (let i = 0; i < WORKING_STATE_MAX_ENTRIES; i++) s.set({ key: `t${i}`, kind: "todo", value: "x" });
    const r = s.set({ key: "extra", kind: "fact", value: "x" });
    expect(r.ok).toBe(false);
    expect(s.size).toBe(WORKING_STATE_MAX_ENTRIES);
  });

  it("updating an existing key at capacity does not evict", () => {
    const s = new WorkingStateStore();
    for (let i = 0; i < WORKING_STATE_MAX_ENTRIES; i++) s.set({ key: `p${i}`, kind: "progress", value: "x" });
    const r = s.set({ key: "p5", kind: "progress", value: "y" });
    expect(r).toMatchObject({ ok: true, dropped: [], replaced: true });
  });

  it("renders blockers and todo first, grouped by kind", () => {
    const s = new WorkingStateStore();
    s.set({ key: "pr", kind: "progress", value: "done a" });
    s.set({ key: "id", kind: "fact", value: "INC-4471" });
    s.set({ key: "d", kind: "decision", value: "use X" });
    s.set({ key: "t", kind: "todo", value: "do b" });
    s.set({ key: "b", kind: "blocker", value: "need creds" });
    const out = s.render();
    expect(out.startsWith("## Working state")).toBe(true);
    const order = ["Blockers", "Todo", "Decisions", "Facts", "Progress"].map((h) => out.indexOf(`### ${h}`));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(out).toContain("- id: INC-4471");
    expect(new WorkingStateStore().render()).toBe("");
  });

  it("bounds render output, dropping progress first", () => {
    const s = new WorkingStateStore();
    s.set({ key: "b", kind: "blocker", value: "keep me" });
    for (let i = 0; i < 20; i++) s.set({ key: `p${i}`, kind: "progress", value: "x".repeat(100) });
    const out = s.render(500);
    expect(out.length).toBeLessThanOrEqual(500);
    expect(out).toContain("keep me");
    expect(out).toContain("omitted");
    expect(out).not.toContain("- p0:");
  });

  it("scrubs secrets from keys and values", () => {
    const s = new WorkingStateStore();
    const secret = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";
    const r = s.set({ key: "token", kind: "fact", value: `key is ${secret}` });
    expect(r.ok).toBe(true);
    expect(JSON.stringify(s.list())).not.toContain(secret);
  });
});

describe("event log", () => {
  const events: WorkingStateEvent[] = [
    { op: "set", key: "a", kind: "fact", value: "1", at },
    { op: "set", key: "b", kind: "todo", value: "2", at },
    { op: "set", key: "a", kind: "fact", value: "3", at },
    { op: "delete", key: "b", at },
  ];

  it("reduces deterministically", () => {
    const one = reduceWorkingState(events).list();
    const two = reduceWorkingState(events).list();
    expect(one).toEqual(two);
    expect(one).toEqual([{ key: "a", kind: "fact", value: "3", updatedAt: at }]);
  });

  it("restores from session entries, ignoring unrelated and malformed ones", () => {
    const entries = [
      { type: "message" },
      ...events.map((data) => ({ type: "custom", customType: WORKING_STATE_CUSTOM_TYPE, data })),
      { type: "custom", customType: "other", data: events[0] },
      { type: "custom", customType: WORKING_STATE_CUSTOM_TYPE, data: { op: "bogus" } },
      { type: "custom", customType: WORKING_STATE_CUSTOM_TYPE },
    ];
    expect(restoreWorkingState(entries).list()).toHaveLength(1);
    expect(getWorkingStateSections(entries)[0]!.value).toBe("3");
  });

  it("replays eviction identically", () => {
    const log: WorkingStateEvent[] = [];
    const live = new WorkingStateStore();
    for (let i = 0; i < 80; i++) {
      const e: WorkingStateEvent = { op: "set", key: `p${i}`, kind: "progress", value: "x", at };
      log.push(e);
      live.apply(e);
    }
    expect(reduceWorkingState(log).list()).toEqual(live.list());
  });
});
