import { describe, expect, it } from "vitest";
import { createInputQueue, type InputQueueDeps } from "./inputQueue";
import { textToCharEvents } from "./keys";
import type { LiveViewInput } from "./types";

function harness(overrides: Partial<InputQueueDeps> = {}, statuses: number[] = []) {
  let clock = 0;
  const posts: { at: number; batch: LiveViewInput[] }[] = [];
  const notices: string[] = [];
  const stopped: string[] = [];
  let inflight = 0;
  let maxInflight = 0;
  const deps: InputQueueDeps = {
    post: async (batch) => {
      inflight += 1;
      maxInflight = Math.max(maxInflight, inflight);
      posts.push({ at: clock, batch });
      await Promise.resolve();
      inflight -= 1;
      return statuses.shift() ?? 200;
    },
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    refreshSession: async () => false,
    onNotice: (n) => notices.push(n),
    onStopped: (r) => stopped.push(r),
    ...overrides,
  };
  return { queue: createInputQueue(deps), posts, notices, stopped, maxInflight: () => maxInflight };
}

const move = (x: number): LiveViewInput => ({ type: "input_mouse", eventType: "mouseMoved", x, y: 0 });
const texts = (posts: { batch: LiveViewInput[] }[]) =>
  posts.flatMap((p) => p.batch.map((e) => (e.type === "input_keyboard" ? e.text : e.eventType)));

describe("input queue", () => {
  it("keeps one request in flight and batches what accumulated, in order", async () => {
    const h = harness();
    const string = "user.name+tag@example.com".slice(0, 25);
    expect(string).toHaveLength(25);
    for (const e of textToCharEvents(string)) h.queue.push(e);
    await h.queue.idle();
    expect(h.maxInflight()).toBe(1);
    expect(h.posts.length).toBeLessThan(25);
    expect(texts(h.posts).join("")).toBe(string);
  });

  it("chunks to at most 64 events per request", async () => {
    const h = harness();
    for (const e of textToCharEvents("a".repeat(300))) h.queue.push(e);
    await h.queue.idle();
    expect(h.posts.every((p) => p.batch.length <= 64)).toBe(true);
    expect(h.posts.reduce((n, p) => n + p.batch.length, 0)).toBe(300);
  });

  it("paces a long paste under the average cap", async () => {
    const h = harness();
    for (const e of textToCharEvents("b".repeat(2000))) h.queue.push(e);
    await h.queue.idle();
    const first = h.posts[0]!.at;
    const last = h.posts[h.posts.length - 1]!;
    const sentBeforeLast = 2000 - last.batch.length;
    const elapsedSec = (last.at - first) / 1000;
    expect(sentBeforeLast / elapsedSec).toBeLessThanOrEqual(400.5);
  });

  it("coalesces consecutive mouseMoved to the latest while queued", async () => {
    const h = harness();
    h.queue.push(move(1));
    h.queue.push(move(2));
    h.queue.push(move(3));
    h.queue.push({ type: "input_mouse", eventType: "mousePressed", x: 3, y: 0 });
    await h.queue.idle();
    const xs = h.posts.flatMap((p) => p.batch).filter((e) => e.type === "input_mouse" && e.eventType === "mouseMoved");
    expect(xs.length).toBeLessThan(3);
    expect(xs[xs.length - 1]).toMatchObject({ x: 3 });
  });

  it("retries the same batch on 429 without reordering", async () => {
    const h = harness({}, [429, 429]);
    for (const e of textToCharEvents("abc")) h.queue.push(e);
    await h.queue.idle();
    expect(h.posts.length).toBeGreaterThanOrEqual(3);
    expect(h.posts[0]!.batch).toEqual(h.posts[1]!.batch);
    const accepted = h.posts.slice(2);
    expect(texts(accepted).join("")).toBe("abc");
    expect(h.stopped).toEqual([]);
  });

  it.each([400, 413])("drops the batch on %i with a notice and continues", async (status) => {
    const h = harness({}, [status]);
    h.queue.push(textToCharEvents("x")[0]!);
    await h.queue.idle();
    h.queue.push(textToCharEvents("y")[0]!);
    await h.queue.idle();
    expect(h.notices).toEqual(["rejected"]);
    expect(texts(h.posts)).toEqual(["x", "y"]);
  });

  it("stops on 409", async () => {
    const h = harness({}, [409]);
    h.queue.push(textToCharEvents("x")[0]!);
    await h.queue.idle();
    h.queue.push(textToCharEvents("y")[0]!);
    await h.queue.idle();
    expect(h.stopped).toEqual(["closed"]);
    expect(h.posts).toHaveLength(1);
  });

  it("tries a fresh session once on 401/403 then retries or stops", async () => {
    let refreshes = 0;
    const ok = harness({ refreshSession: async () => (refreshes += 1, true) }, [401]);
    ok.queue.push(textToCharEvents("x")[0]!);
    await ok.queue.idle();
    expect(refreshes).toBe(1);
    expect(ok.posts).toHaveLength(2);

    const bad = harness({ refreshSession: async () => false }, [403]);
    bad.queue.push(textToCharEvents("x")[0]!);
    await bad.queue.idle();
    expect(bad.stopped).toEqual(["unauthorized"]);
  });
});
