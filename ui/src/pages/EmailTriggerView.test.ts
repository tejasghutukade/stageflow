import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchEmailTrigger, fetchEmailTriggers, type EmailTriggerRule } from "../api";
import { parseHash, triggerPath } from "../routes";
import { EmailTriggerFields, EmailTriggerRow, emailTriggerFilter } from "./EmailTriggerView";

const rule: EmailTriggerRule = {
  triggerId: "test-rule", version: 2, enabled: true,
  activeAfter: "2026-10-06T18:31:36.173Z",
  accountId: "personal-inbox", folder: "INBOX",
  from: "sender@example.com", pipeline: "hello-email-reply.pipeline.yaml",
  task: { id: "hello-email-reply-task", goal: "Reply once" },
  includeBody: false, bodyLimit: 8192,
};

afterEach(() => vi.unstubAllGlobals());

describe("email triggers in the operator console", () => {
  it("shows the sender, inbox, pipeline and enabled status in a table row", () => {
    const html = renderToStaticMarkup(createElement(EmailTriggerRow, { trigger: rule }));
    expect(html).toContain("hello-email-reply-task");
    expect(html).toContain("sender@example.com");
    expect(html).toContain("personal-inbox / INBOX");
    expect(html).toContain("hello-email-reply.pipeline.yaml");
    expect(html).toContain("Enabled");
    expect(html).toContain("#/triggers/email%3Atest-rule");
    expect(html).not.toContain(">Fire<");
    expect(html).not.toContain("never");
  });

  it("shows disabled rules and optional subject filters", () => {
    const filtered = { ...rule, enabled: false, subjectContains: "hello" };
    expect(emailTriggerFilter(filtered)).toContain("subject contains “hello”");
    expect(renderToStaticMarkup(createElement(EmailTriggerRow, { trigger: filtered }))).toContain("Disabled");
  });

  it("shows complete matching conditions without exposing task context", () => {
    const html = renderToStaticMarkup(createElement(EmailTriggerFields, {
      trigger: { ...rule, from: undefined, task: { ...rule.task, context: "private-context" } },
    }));
    expect(html).toContain("Any sender");
    expect(html).toContain("Any subject");
    expect(html).toContain(rule.activeAfter);
    expect(html).not.toContain("private-context");
  });

  it("round-trips email trigger detail links", () => {
    expect(parseHash(`#${triggerPath("email:test-rule")}`)).toEqual({ name: "trigger", triggerId: "email:test-rule" });
  });

  it("loads rules from the email connector rather than the YAML catalog", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ triggers: [rule] }) });
    vi.stubGlobal("fetch", fetchMock);
    expect(await fetchEmailTriggers()).toEqual({ triggers: [rule] });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/email/triggers");
    fetchMock.mockResolvedValue({ ok: true, json: async () => rule });
    expect(await fetchEmailTrigger("rule/encoded")).toEqual(rule);
    expect(fetchMock.mock.calls[1][0]).toBe("/api/email/triggers/rule%2Fencoded");
  });
});
