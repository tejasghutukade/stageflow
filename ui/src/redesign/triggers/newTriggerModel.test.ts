import { describe, expect, it } from "vitest";
import {
  buildCreateTriggerBody,
  buildTriggerEvent,
  buildUpdateTriggerBody,
  describeCron,
  directoryForPipeline,
  emptyNewTriggerForm,
  formFromInitial,
  formatNextRun,
  timezoneOptions,
  triggerFireCommand,
  triggerYamlPath,
  validateNewTriggerForm,
  type NewTriggerForm,
} from "./newTriggerModel";
import { buildTriggerYamlPreview } from "./triggerYamlPreview";

function form(patch: Partial<NewTriggerForm> = {}): NewTriggerForm {
  return {
    ...emptyNewTriggerForm(),
    id: "pr-review",
    pipeline: "pr-review-loop",
    task: "review",
    github: { repo: "acme/app", secretRef: "GITHUB_TOKEN", action: "opened", author: "" },
    ...patch,
  };
}

describe("validateNewTriggerForm", () => {
  it("accepts a complete github trigger", () => {
    expect(validateNewTriggerForm(form(), "create")).toEqual({});
  });

  it("requires kebab-case ids up to 64 chars on create only", () => {
    expect(validateNewTriggerForm(form({ id: "" }), "create").id).toBeDefined();
    expect(validateNewTriggerForm(form({ id: "Bad_Id" }), "create").id).toBeDefined();
    expect(validateNewTriggerForm(form({ id: "1abc" }), "create").id).toBeDefined();
    expect(validateNewTriggerForm(form({ id: "a".repeat(65) }), "create").id).toBeDefined();
    expect(validateNewTriggerForm(form({ id: "a".repeat(64) }), "create").id).toBeUndefined();
    expect(validateNewTriggerForm(form({ id: "Bad_Id" }), "edit").id).toBeUndefined();
  });

  it("requires a pipeline and a catalog task unless dynamic", () => {
    expect(validateNewTriggerForm(form({ pipeline: "" }), "create").pipeline).toBeDefined();
    expect(validateNewTriggerForm(form({ task: "" }), "create").task).toBeDefined();
    expect(
      validateNewTriggerForm(form({ task: "", taskMode: "dynamic" }), "create").task,
    ).toBeUndefined();
  });

  it("requires cron for schedule and rejects schedule + dynamic", () => {
    expect(validateNewTriggerForm(form({ kind: "schedule", cron: " " }), "create").cron).toBeDefined();
    expect(
      validateNewTriggerForm(form({ kind: "schedule", taskMode: "dynamic" }), "create").schedule,
    ).toBeDefined();
    expect(validateNewTriggerForm(form({ kind: "schedule" }), "create")).toEqual({});
  });

  it("requires an owner/name github repo", () => {
    const base = form();
    expect(
      validateNewTriggerForm({ ...base, github: { ...base.github, repo: "acme" } }, "create").repo,
    ).toBeDefined();
    expect(
      validateNewTriggerForm({ ...base, github: { ...base.github, repo: "" } }, "create").repo,
    ).toBeDefined();
  });

  it("requires webhook secretRef and header", () => {
    const errors = validateNewTriggerForm(
      form({ source: "webhook", webhook: { secretRef: "", header: "", scheme: "hex" } }),
      "create",
    );
    expect(errors.secretRef).toBeDefined();
    expect(errors.header).toBeDefined();
  });

  it("requires email host, port, user and secretRef", () => {
    const errors = validateNewTriggerForm(
      form({
        source: "email",
        email: { host: "", port: "abc", user: "", secretRef: "", subject: "" },
      }),
      "create",
    );
    expect(Object.keys(errors).sort()).toEqual(["host", "port", "secretRef", "user"]);
  });

  it("ignores source fields when kind is not event", () => {
    const base = form({ kind: "manual" });
    expect(
      validateNewTriggerForm({ ...base, github: { ...base.github, repo: "" } }, "create"),
    ).toEqual({});
  });
});

describe("buildTriggerEvent", () => {
  it("builds a github pull request event", () => {
    const base = form();
    expect(buildTriggerEvent({ ...base, github: { ...base.github, author: " octo " } })).toEqual({
      source: "github.pull_request",
      match: { action: "opened", author: "octo" },
      config: { repo: "acme/app", secretRef: "GITHUB_TOKEN" },
    });
  });

  it("builds a webhook event, omitting the default scheme", () => {
    expect(buildTriggerEvent(form({ source: "webhook" }))).toEqual({
      source: "webhook",
      config: { secretRef: "WEBHOOK_SECRET", header: "X-Hub-Signature-256" },
    });
    expect(
      buildTriggerEvent(
        form({
          source: "webhook",
          webhook: { secretRef: "S", header: "H", scheme: "base64" },
        }),
      ).config,
    ).toEqual({ secretRef: "S", header: "H", scheme: "base64" });
  });

  it("builds an email event with numeric port and optional subject", () => {
    expect(
      buildTriggerEvent(
        form({
          source: "email",
          email: { host: "imap.x", port: "993", user: "me", secretRef: "PW", subject: "Invoice" },
        }),
      ),
    ).toEqual({
      source: "email.message",
      match: { subject: "Invoice" },
      config: { host: "imap.x", port: 993, user: "me", secretRef: "PW" },
    });
  });
});

describe("request bodies", () => {
  it("create omits task in dynamic mode and schedule/event by kind", () => {
    expect(buildCreateTriggerBody(form({ kind: "manual", taskMode: "dynamic" }), "examples")).toEqual({
      directory: "examples",
      id: "pr-review",
      pipeline: "pr-review-loop",
      kind: "manual",
      enabled: true,
    });
    const scheduled = buildCreateTriggerBody(
      form({ kind: "schedule", cron: "0 2 * * *", timezone: "UTC" }),
      ".",
    );
    expect(scheduled.schedule).toEqual({ cron: "0 2 * * *", timezone: "UTC" });
    expect(scheduled.task).toBe("review");
    expect("event" in scheduled).toBe(false);
    const event = buildCreateTriggerBody(form(), ".");
    expect(event.event?.source).toBe("github.pull_request");
    expect("schedule" in event).toBe(false);
  });

  it("update nulls task, schedule and event when unused", () => {
    expect(buildUpdateTriggerBody(form({ kind: "manual", taskMode: "dynamic" }))).toEqual({
      pipeline: "pr-review-loop",
      task: null,
      kind: "manual",
      schedule: null,
      event: null,
      enabled: true,
    });
  });

  it("derives directory from the selected pipeline path", () => {
    const pipelines = [
      { id: "a", path: "examples/x/a.pipeline.yaml", stages: [] },
      { id: "b", path: "b.pipeline.yaml", stages: [] },
    ];
    expect(directoryForPipeline(pipelines, "a")).toBe("examples/x");
    expect(directoryForPipeline(pipelines, "b")).toBe(".");
  });
});

describe("formFromInitial", () => {
  it("round-trips a github trigger and preserves unknown match/config keys", () => {
    const f = formFromInitial({
      id: "pr",
      pipeline: "p",
      kind: "event",
      enabled: false,
      event: {
        source: "github.pull_request",
        match: { action: "merged", base: "main" },
        config: { repo: "a/b", secretRef: "TOK", interval: 30 },
      },
    });
    expect(f.taskMode).toBe("dynamic");
    expect(f.github).toEqual({ repo: "a/b", secretRef: "TOK", action: "merged", author: "" });
    expect(buildUpdateTriggerBody(f).event).toEqual({
      source: "github.pull_request",
      match: { base: "main", action: "merged" },
      config: { interval: 30, repo: "a/b", secretRef: "TOK" },
    });
  });

  it("loads schedule and email fields", () => {
    const sched = formFromInitial({
      id: "s",
      pipeline: "p",
      task: "t",
      kind: "schedule",
      enabled: true,
      schedule: { cron: "5 4 * * *", timezone: "Asia/Tokyo" },
    });
    expect(sched.cron).toBe("5 4 * * *");
    expect(sched.timezone).toBe("Asia/Tokyo");
    expect(sched.taskMode).toBe("catalog");
    const mail = formFromInitial({
      id: "m",
      pipeline: "p",
      kind: "event",
      enabled: true,
      event: { source: "email.message", config: { host: "h", port: 143, user: "u", secretRef: "S" } },
    });
    expect(mail.source).toBe("email");
    expect(mail.email.port).toBe("143");
  });
});

describe("display helpers", () => {
  it("describes simple cron expressions", () => {
    expect(describeCron("0 2 * * *")).toBe("Every day at 02:00");
    expect(describeCron("30 * * * *")).toBe("Every hour at :30");
    expect(describeCron("*/15 * * * *")).toBe("Every 15 minutes");
    expect(describeCron("0 9 * * 1-5")).toBe("Weekdays at 09:00");
    expect(describeCron("0 9 * * 1")).toBe("Every Monday at 09:00");
    expect(describeCron("0 9 1 * *")).toBeNull();
    expect(describeCron("bad")).toBeNull();
  });

  it("formats next runs in the chosen timezone", () => {
    const now = new Date("2026-10-05T15:00:00Z");
    expect(formatNextRun(new Date("2026-10-06T02:00:00Z"), now, "UTC")).toEqual({
      date: "Tue Oct 6 · 02:00",
      relative: "in 11h",
    });
    expect(formatNextRun(new Date("2026-10-07T02:00:00Z"), now, "UTC").relative).toBe("in 1d 11h");
    expect(formatNextRun(new Date("2026-10-05T15:20:00Z"), now, "UTC").relative).toBe("in 20m");
  });

  it("adds an unknown initial timezone to the options", () => {
    expect(timezoneOptions("UTC")).not.toContain("Asia/Tokyo");
    expect(timezoneOptions("Asia/Tokyo")).toContain("Asia/Tokyo");
  });

  it("builds yaml path and fire command", () => {
    expect(triggerYamlPath("pr-review")).toBe("triggers/pr-review.trigger.yaml");
    expect(triggerYamlPath("", undefined)).toBe("triggers/….trigger.yaml");
    expect(triggerYamlPath("x", "/repo/examples/triggers/nightly.trigger.yaml")).toBe(
      "triggers/nightly.trigger.yaml",
    );
    expect(triggerFireCommand("")).toBe("sf trigger fire …");
    expect(triggerFireCommand("pr-review")).toBe("sf trigger fire pr-review");
  });
});

describe("buildTriggerYamlPreview", () => {
  it("renders an event trigger with nested match and config", () => {
    expect(
      buildTriggerYamlPreview({
        id: "pr-review",
        pipeline: "pr-review-loop",
        kind: "event",
        enabled: true,
        event: buildTriggerEvent(form()),
      }),
    ).toBe(
      [
        "id: pr-review",
        "pipeline: pr-review-loop",
        "kind: event",
        "enabled: true",
        "event:",
        "  source: github.pull_request",
        "  match:",
        "    action: opened",
        "  config:",
        "    repo: acme/app",
        "    secretRef: GITHUB_TOKEN",
        "",
      ].join("\n"),
    );
  });

  it("quotes cron and includes the catalog task", () => {
    const yaml = buildTriggerYamlPreview({
      id: "nightly",
      pipeline: "p",
      task: "t",
      kind: "schedule",
      enabled: false,
      schedule: { cron: "0 2 * * *", timezone: "UTC" },
    });
    expect(yaml).toContain("task: t\n");
    expect(yaml).toContain('  cron: "0 2 * * *"\n');
    expect(yaml).toContain("enabled: false\n");
  });
});
