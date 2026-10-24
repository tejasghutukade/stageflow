import { describe, expect, it } from "vitest";
import { scrubSecrets, SECRET_KEY_RE } from "../src/compaction/scrub.js";
import { composeCompactionSummary } from "../src/compaction/summarize.js";
import { WorkingStateStore } from "../src/compaction/workingState.js";
import { createWorkingStateTool } from "../src/tools/workingState.js";

const SECRETS = [
  "token=abc123def456",
  "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.FAKE-PAYLOAD-7731.sig_93ab1c",
  "Set-Cookie: session=sf_c00kie_9f8e7d6c5b4a3210; Path=/",
  "api_key: sk-live-0123456789abcdef0123",
  "password=hunter2hunter2",
];

describe("scrubbing", () => {
  it.each(SECRETS)("removes %s", (secret) => {
    const out = scrubSecrets(`before ${secret} after`);
    expect(out).toContain("[redacted]");
    expect(out).not.toMatch(/abc123def456|FAKE-PAYLOAD-7731|sf_c00kie|sk-live-0123|hunter2/);
  });

  it("recognizes secret-looking key names", () => {
    for (const key of ["session", "x-csrf-token", "api_key", "jwt", "Cookie"]) expect(SECRET_KEY_RE.test(key)).toBe(true);
    expect(SECRET_KEY_RE.test("incident_id")).toBe(false);
  });
});

describe("working_state uses the same scrubber", () => {
  it.each(SECRETS)("redacts %s from a value and tells the model", async (secret) => {
    const store = new WorkingStateStore();
    const tool = createWorkingStateTool({ store, persist: () => {} });
    const out = await tool.execute("c1", { operation: "set", key: "note", kind: "fact", value: `seen ${secret} in the log` });
    expect(out.content[0]!.text).toContain("redacted");
    const rendered = store.render();
    expect(rendered).not.toMatch(/abc123def456|FAKE-PAYLOAD-7731|sf_c00kie|sk-live-0123|hunter2/);
  });

  it("stays quiet when nothing was redacted", async () => {
    const store = new WorkingStateStore();
    const tool = createWorkingStateTool({ store, persist: () => {} });
    const out = await tool.execute("c1", { operation: "set", key: "next", kind: "todo", value: "read shard 4" });
    expect(out.content[0]!.text).not.toContain("redacted");
  });

  it("a secret that got into the stored state still cannot reach the summary", async () => {
    const out = await composeCompactionSummary({
      messages: [],
      state: [{ key: "leak", kind: "fact", value: "password=hunter2hunter2", updatedAt: "2026-03-14T00:00:00Z" }],
      summarize: async () => ({ summary: "## Goal\nx" }),
    });
    expect(out.summary).not.toContain("hunter2");
  });
});
