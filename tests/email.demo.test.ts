import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { loadPipelineOutcome } from "../src/config/loadPipeline.js";
import { loadTask } from "../src/config/loadTask.js";
import { payloadInstanceMismatch } from "../src/envelope/payloadSchema.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("hello email catalog", () => {
  it("loads one body-driven reply stage with the existing account and reply contract", async () => {
    const result = await loadPipelineOutcome("examples/hello-email/hello-email-reply.pipeline.yaml", { cwd: root, projectRoot: root });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.value.stages).toHaveLength(1);
    const stage = result.value.stages[0];
    expect(stage.email).toEqual([{ accountId: "personal-inbox", operations: ["getMessage", "reply"] }]);
    expect(stage.system_prompt).toContain("Tell me a joke");
    expect(stage.system_prompt).toContain("host clock");
    expect(stage.system_prompt).toContain("bodyTruncated");
    expect(stage.system_prompt).toContain("quoted history");
    expect(payloadInstanceMismatch({ replied: true, reason: "Answered request", operationId: "receipt-1" }, stage.payload_schema)).toBeUndefined();
  });
  it("loads one send-only stage and requires a recipient before a run", async () => {
    const result = await loadPipelineOutcome("examples/hello-email/hello-email.pipeline.yaml", { cwd: root, projectRoot: root });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.value.stages).toHaveLength(1);
    const stage = result.value.stages[0];
    expect(stage.email).toEqual([{ accountId: "personal-inbox", operations: ["send"] }]);
    const task = await loadTask(path.join(root, "examples/hello-email/hello-email.task.yaml"));
    expect(task.id).toBe("hello-email-task");
    expect(payloadInstanceMismatch({ recipient: "" }, stage.clone_input_schema)).toBeDefined();
    expect(payloadInstanceMismatch({ recipient: "recipient@example.com" }, stage.clone_input_schema)).toBeUndefined();
  });

  it("ships one disabled personal account with environment-only credentials", async () => {
    const example = parse(await readFile(path.join(root, "email.example.yaml"), "utf8"));
    expect(example.accounts).toHaveLength(1);
    const account = example.accounts[0];
    expect(account.accountId).toBe("personal-inbox");
    expect(account.enabled).toBe(false);
    expect(account.imap.auth).toEqual({ type: "password", secretRef: "env:PERSONAL_EMAIL_PASSWORD" });
    expect(account.smtp.auth).toEqual(account.imap.auth);
  });
});
