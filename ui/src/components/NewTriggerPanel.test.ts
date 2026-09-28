import { describe, expect, it } from "vitest";
import { triggerCreateBanner, validateFields } from "./NewTriggerPanel";

const validValues = {
  directory: "triggers",
  id: "nightly-release",
  pipeline: "release",
  task: "release-task",
  kind: "manual" as const,
  cron: "",
  source: "",
};

describe("NewTriggerPanel validateFields", () => {
  it("passes for a valid manual trigger", () => {
    expect(validateFields(validValues)).toEqual({});
  });

  it("requires a directory", () => {
    expect(validateFields({ ...validValues, directory: "  " })).toEqual({
      directory: "Directory is required.",
    });
  });

  it("requires an id", () => {
    expect(validateFields({ ...validValues, id: "" })).toEqual({
      id: "Id is required.",
    });
  });

  it("rejects a non-kebab-case id", () => {
    expect(validateFields({ ...validValues, id: "Nightly_Release" })).toEqual({
      id: "Id must be lowercase kebab-case.",
    });
  });

  it("requires a pipeline selection", () => {
    expect(validateFields({ ...validValues, pipeline: "" })).toEqual({
      pipeline: "Select a pipeline.",
    });
  });

  it("requires a task selection", () => {
    expect(validateFields({ ...validValues, task: "" })).toEqual({
      task: "Select a task.",
    });
  });

  it("requires cron for kind=schedule", () => {
    expect(
      validateFields({ ...validValues, kind: "schedule", cron: "" }),
    ).toEqual({ cron: "Cron expression is required." });
  });

  it("passes for kind=schedule with a cron expression", () => {
    expect(
      validateFields({ ...validValues, kind: "schedule", cron: "0 * * * *" }),
    ).toEqual({});
  });

  it("requires a source for kind=event", () => {
    expect(
      validateFields({ ...validValues, kind: "event", source: "" }),
    ).toEqual({ source: "Event source is required." });
  });

  it("passes for kind=event with a source", () => {
    expect(
      validateFields({ ...validValues, kind: "event", source: "github" }),
    ).toEqual({});
  });
});

describe("NewTriggerPanel triggerCreateBanner", () => {
  it("reports a duplicate id on 409", () => {
    expect(triggerCreateBanner(409)).toBe(
      "Could not create trigger: this id already exists.",
    );
  });

  it("reports a validation failure on 422 with the server detail appended", () => {
    expect(
      triggerCreateBanner(422, 'Trigger references unknown pipeline "foo"'),
    ).toBe(
      'Could not create trigger: invalid reference or schedule. Trigger references unknown pipeline "foo"',
    );
  });

  it("reports a bad request on 400", () => {
    expect(triggerCreateBanner(400, "id is required")).toBe(
      "Could not create trigger: invalid input. id is required",
    );
  });

  it("falls back to a generic message for other statuses", () => {
    expect(triggerCreateBanner(500)).toBe("Could not create trigger. Try again.");
  });
});
