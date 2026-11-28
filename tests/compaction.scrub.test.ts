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

  it("redacts PEM private key blocks and leaves the words PRIVATE KEY alone", () => {
    const body = "MIIBogIBAAJBALFakeKeyMaterialForTestsOnly1234567890";
    const block = (label: string, ending = true) =>
      [`-----BEGIN ${label}-----`, body, ...(ending ? [`-----END ${label}-----`] : [])].join("\n");
    const inline = scrubSecrets(`before\n${block("RSA PRIVATE KEY")}\nafter`);
    expect(inline).toBe("before\n[redacted]\nafter");
    expect(inline).not.toContain(body);
    expect(inline).not.toContain("BEGIN");
    const fromFile = scrubSecrets(block("OPENSSH PRIVATE KEY"));
    expect(fromFile).toBe("[redacted]");
    const encoded = Buffer.from(block("PRIVATE KEY"), "utf8").toString("utf8");
    expect(scrubSecrets(encoded)).toBe("[redacted]");
    const truncated = scrubSecrets(`keep\n${block("EC PRIVATE KEY", false)}\nstill inside`);
    expect(truncated).toBe("keep\n[redacted]");
    expect(truncated).not.toContain(body);
    expect(truncated).not.toContain("still inside");
    const crlf = scrubSecrets(`-----BEGIN ENCRYPTED PRIVATE KEY-----\r\n${body}\r\n-----END ENCRYPTED PRIVATE KEY-----`);
    expect(crlf).toBe("[redacted]");
    expect(crlf).not.toContain(body);
    const two = scrubSecrets(`a\n${block("RSA PRIVATE KEY")}\nb\n${block("EC PRIVATE KEY")}\nc`);
    expect(two).toBe("a\n[redacted]\nb\n[redacted]\nc");
    expect(two).not.toContain(body);
    const prose = "store the PRIVATE KEY in the vault";
    expect(scrubSecrets(prose)).toBe(prose);
    const publicKey = `-----BEGIN PUBLIC KEY-----\n${body}\n-----END PUBLIC KEY-----`;
    expect(scrubSecrets(publicKey)).toContain(body);
    expect(scrubSecrets(publicKey)).toContain("BEGIN PUBLIC KEY");
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
