import { describe, expect, it } from "vitest";
import { ChannelError } from "../src/channels/errors.js";
import { SecretFromEnvError } from "../src/config/secretFromEnvOrFile.js";
import { parseEventField } from "../src/config/createTrigger.js";
import { resolveTriggerSecret, secretRefError } from "../src/config/triggerSecret.js";
import { applyTriggerSecret } from "../src/config/triggerSecretEdit.js";
import { findingsForTriggerRefs } from "../src/config/validateCatalog.js";

const VALUE = "very-secret-value-123";
const refs = { pipelineIds: new Set(["p"]), taskIds: new Set<string>() };

describe("resolveTriggerSecret", () => {
  const secrets = { get: (name: string) => (name === "trigger.t.secret" ? VALUE : undefined) };

  it("reads store:NAME from the store and a plain name from the environment", () => {
    expect(resolveTriggerSecret("store:trigger.t.secret", { env: {}, secrets })).toBe(VALUE);
    expect(resolveTriggerSecret("TOKEN", { env: { TOKEN: "env-v" }, secrets })).toBe("env-v");
  });

  it("returns undefined when unset", () => {
    expect(resolveTriggerSecret("store:trigger.x.secret", { env: {}, secrets })).toBeUndefined();
    expect(resolveTriggerSecret("store:trigger.t.secret", { env: {} })).toBeUndefined();
    expect(resolveTriggerSecret("store:bad name", { env: {}, secrets })).toBeUndefined();
    expect(resolveTriggerSecret("TOKEN", { env: {}, secrets })).toBeUndefined();
  });

  it("turns a store failure into a code-only error", () => {
    const failing = { get: () => { throw new ChannelError("CHANNEL_STORAGE_FAILED"); } };
    let caught: unknown;
    try { resolveTriggerSecret("store:trigger.t.secret", { env: {}, secrets: failing }); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(SecretFromEnvError);
    expect((caught as Error).message).toBe("secret store unavailable (CHANNEL_STORAGE_FAILED)");
  });
});

describe("store: secretRef validation", () => {
  it("accepts a good name and flags a malformed one on the three kinds", () => {
    expect(secretRefError("store:trigger.t.secret")).toBeNull();
    expect(secretRefError("PLAIN")).toBeNull();
    expect(secretRefError("store:")).not.toBeNull();
    expect(secretRefError("store:-x")).not.toBeNull();
    expect(secretRefError(`store:${"a".repeat(201)}`)).not.toBeNull();

    const make = (source: string, secretRef: string, match?: Record<string, unknown>) => ({
      id: "t", pipeline: "p", kind: "event" as const, enabled: true,
      event: { source, ...(match ? { match } : {}), config: { secretRef } },
    });
    for (const source of ["webhook", "email.message", "github.pull_request"]) {
      const match = source.startsWith("github.") ? { action: "opened" } : undefined;
      expect(findingsForTriggerRefs("/r", "/r/t.yaml", make(source, "store:ok.name", match), refs)).toEqual([]);
      const findings = findingsForTriggerRefs("/r", "/r/t.yaml", make(source, "store:bad name", match), refs);
      expect(findings.map((f) => f.code)).toEqual(["trigger.invalid_secret_ref"]);
    }
  });

  it("rejects a malformed name when a trigger is created or edited", () => {
    const parsed = parseEventField({ source: "webhook", config: { secretRef: "store:no good" } });
    expect(parsed.ok).toBe(false);
    expect(parseEventField({ source: "webhook", config: { secretRef: "store:good" } }).ok).toBe(true);
  });
});

describe("applyTriggerSecret", () => {
  function memory() {
    const values = new Map<string, string>();
    return {
      values,
      get: (n: string) => values.get(n),
      set: (n: string, v: string) => void values.set(n, v),
      delete: (n: string) => void values.delete(n),
      deleteWithPrefix: () => undefined,
    };
  }

  it("restores the previous value or deletes a new one when the change fails or throws", async () => {
    const store = memory();
    await applyTriggerSecret(store, "t", { secret: "new", clear: false }, async () => ({ ok: false }));
    expect(store.values.size).toBe(0);
    store.values.set("trigger.t.secret", "old");
    await applyTriggerSecret(store, "t", { secret: "new", clear: false }, async () => ({ ok: false }));
    expect(store.get("trigger.t.secret")).toBe("old");
    await expect(
      applyTriggerSecret(store, "t", { secret: "new", clear: false }, async () => { throw new Error("boom"); }),
    ).rejects.toThrow("boom");
    expect(store.get("trigger.t.secret")).toBe("old");
  });

  it("clears only after the change succeeded", async () => {
    const store = memory();
    store.values.set("trigger.t.secret", "old");
    await applyTriggerSecret(store, "t", { clear: true }, async () => ({ ok: false }));
    expect(store.get("trigger.t.secret")).toBe("old");
    await applyTriggerSecret(store, "t", { clear: true }, async () => ({ ok: true }));
    expect(store.get("trigger.t.secret")).toBeUndefined();
  });
});
