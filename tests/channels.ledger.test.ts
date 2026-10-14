import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ChannelSends } from "../src/channels/ledger.js";
import { ChannelError } from "../src/channels/errors.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "sf-ledger-"));
  roots.push(root);
  return { root, ledger: new ChannelSends(root), file: path.join(root, ".stageflow", "channel-sends.json") };
}
const id = (operationKey = "k1", hash = "h1", connectionId = "c1") => ({ connectionId, operationKey, hash });
const receipt = (n = 1) => ({ providerMessageId: `m${n}`, submittedAt: "2026-01-01T00:00:00.000Z" });
async function code(promise: Promise<unknown>): Promise<string | undefined> {
  try { await promise; } catch (error) { return error instanceof ChannelError ? error.code : "other"; }
  return undefined;
}

describe("ChannelSends", () => {
  it("sends once and returns the stored receipt for a repeat of the same operation", async () => {
    const { ledger } = await setup();
    let calls = 0;
    const submit = async () => receipt(++calls);
    const first = await ledger.send(id(), submit);
    const second = await ledger.send(id(), submit);
    expect(calls).toBe(1);
    expect(second).toEqual(first);
    expect(ledger.list()[0]?.state).toBe("submitted");
  });

  it("shares one in-flight send between concurrent identical requests", async () => {
    const { ledger } = await setup();
    let calls = 0;
    const submit = async () => { calls++; await new Promise(r => setTimeout(r, 20)); return receipt(calls); };
    const [a, b] = await Promise.all([ledger.send(id(), submit), ledger.send(id(), submit)]);
    expect(calls).toBe(1);
    expect(a).toEqual(b);
  });

  it("refuses the same key with different content", async () => {
    const { ledger } = await setup();
    await ledger.send(id("k", "h1"), async () => receipt());
    expect(await code(ledger.send(id("k", "h2"), async () => receipt()))).toBe("CHANNEL_OPERATION_CONFLICT");
  });

  it("keeps connections separate", async () => {
    const { ledger } = await setup();
    let calls = 0;
    await ledger.send(id("k", "h", "a"), async () => receipt(++calls));
    await ledger.send(id("k", "h", "b"), async () => receipt(++calls));
    expect(calls).toBe(2);
  });

  it("makes a definite failure sticky and does not resend", async () => {
    const { ledger } = await setup();
    let calls = 0;
    const submit = async () => { calls++; throw new ChannelError("CHANNEL_AUTH_FAILED", false); };
    expect(await code(ledger.send(id(), submit))).toBe("CHANNEL_AUTH_FAILED");
    expect(await code(ledger.send(id(), submit))).toBe("CHANNEL_AUTH_FAILED");
    expect(calls).toBe(1);
    expect(ledger.list()[0]).toMatchObject({ state: "failed", error: { code: "CHANNEL_AUTH_FAILED", retryable: false } });
  });

  it("treats an ambiguous failure, including a non-channel error, as unknown and never resends", async () => {
    const { ledger } = await setup();
    let calls = 0;
    const submit = async () => { calls++; throw new Error("socket hang up with token-abc123"); };
    expect(await code(ledger.send(id("k1"), submit))).toBe("CHANNEL_SEND_OUTCOME_UNKNOWN");
    expect(await code(ledger.send(id("k1"), submit))).toBe("CHANNEL_SEND_OUTCOME_UNKNOWN");
    expect(calls).toBe(1);
    expect(ledger.list()[0]?.state).toBe("unknown");
  });

  it("rewrites a provider error to carry only the code", async () => {
    const { ledger } = await setup();
    try { await ledger.send(id(), async () => { throw new ChannelError("CHANNEL_RATE_LIMIT", true); }); } catch (error) {
      expect(error).toMatchObject({ code: "CHANNEL_RATE_LIMIT", retryable: true, message: "CHANNEL_RATE_LIMIT" });
    }
  });

  it("persists records and turns a pending record from a crash into an unknown outcome", async () => {
    const { root, ledger, file } = await setup();
    await ledger.send(id("done"), async () => receipt());
    void ledger.send(id("crash"), () => new Promise(() => undefined));
    await new Promise(r => setTimeout(r, 10));
    const reopened = new ChannelSends(root);
    expect(reopened.list().map(r => [r.operationKey, r.state])).toEqual([["done", "submitted"], ["crash", "unknown"]]);
    expect(await code(reopened.send(id("crash"), async () => receipt()))).toBe("CHANNEL_SEND_OUTCOME_UNKNOWN");
    expect((await reopened.send(id("done"), async () => { throw new Error("must not run"); })).providerMessageId).toBe("m1");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("never stores message content", async () => {
    const { ledger, file } = await setup();
    await ledger.send({ connectionId: "c", operationKey: "k", hash: "only-a-hash" }, async () => receipt());
    const raw = await readFile(file, "utf8");
    expect(raw).toContain("only-a-hash");
    expect(raw).not.toMatch(/text|subject|body/i);
  });

  it("stops accepting sends when closed", async () => {
    const { ledger } = await setup();
    ledger.setAccepting(false);
    expect(await code(ledger.send(id(), async () => receipt()))).toBe("CHANNEL_CONNECTION_FAILED");
  });

  it("expires finished records after 30 days but keeps unresolved ones", async () => {
    const { root, file } = await setup();
    const old = new Date(Date.now() - 31 * 86400000).toISOString();
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify([
      { operationId: "1", connectionId: "c", operationKey: "old-done", hash: "h", state: "submitted", createdAt: old, receipt: receipt() },
      { operationId: "2", connectionId: "c", operationKey: "old-unknown", hash: "h", state: "unknown", createdAt: old },
    ]));
    const ledger = new ChannelSends(root);
    await ledger.send(id("fresh"), async () => receipt());
    expect(ledger.list().map(r => r.operationKey).sort()).toEqual(["fresh", "old-unknown"]);
  });
});
