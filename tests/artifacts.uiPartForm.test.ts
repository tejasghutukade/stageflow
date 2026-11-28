import { describe, expect, it } from "vitest";
import { parseUiPart, UI_PART_KIND_FORM, UI_PART_SCHEMA_VERSION } from "../src/artifacts/uiPart.js";
import {
  UI_PART_FORM_MAX_FIELDS,
  UI_PART_FORM_MAX_SUBMIT_TEXT,
  coerceFormValues,
  fillFormTemplate,
  formChannelFallback,
  formUiEventKey,
  parseUiPartForm,
  validateFormValues,
} from "../src/artifacts/uiPartForm.js";

const valid = {
  v: UI_PART_SCHEMA_VERSION,
  kind: UI_PART_KIND_FORM,
  id: "weekly_input",
  title: "Weekly numbers",
  description: "Send the revenue figure for this week.",
  fields: [
    { id: "revenue", label: "Revenue (USD)", type: "number", required: true, min: 0 },
    { id: "notes", label: "Notes", type: "string", multiline: true, required: false, maxLength: 200 },
  ],
  submit: { template: "Revenue this week: {{revenue}}\nNotes: {{notes}}" },
  fallback: { text: "Open the form in the console", url: "https://example.com/#/agents" },
};

describe("ui part form schema", () => {
  it("parses a valid form part", () => {
    expect(parseUiPartForm(valid)).toEqual({ ok: true, part: valid });
    expect(parseUiPart(valid)).toEqual({ ok: true, part: valid });
  });

  it("rejects duplicate field ids", () => {
    const dup = {
      ...valid,
      fields: [
        { id: "revenue", label: "A", type: "string" },
        { id: "revenue", label: "B", type: "string" },
      ],
    };
    expect(parseUiPartForm(dup)).toEqual({ ok: false });
  });

  it("rejects too many fields", () => {
    const fields = Array.from({ length: UI_PART_FORM_MAX_FIELDS + 1 }, (_, index) => ({
      id: `field_${index}`,
      label: `Field ${index}`,
      type: "string" as const,
    }));
    expect(parseUiPartForm({ ...valid, fields })).toEqual({ ok: false });
  });

  it("validates values and fills the submit template", () => {
    const issues = validateFormValues(valid as never, { notes: "ok" });
    expect(issues).toEqual([{ field: "revenue", message: "is required" }]);
    const values = coerceFormValues(valid as never, { revenue: 1200, notes: "strong week" });
    expect(fillFormTemplate(valid.submit.template, values)).toBe("Revenue this week: 1200\nNotes: strong week");
  });

  it("builds the ui-events key", () => {
    expect(formUiEventKey("weekly_input")).toBe("_ui/form/weekly_input");
  });

  it("renders a channel fallback without raw JSON", () => {
    const text = formChannelFallback(valid as never, true);
    expect(text).toContain("Weekly numbers");
    expect(text).toContain("Revenue (USD)");
    expect(text).toContain("https://example.com");
    expect(text).not.toContain('"kind":"form"');
  });

  it("caps submit template size at validation", () => {
    const huge = "x".repeat(UI_PART_FORM_MAX_SUBMIT_TEXT + 10);
    expect(parseUiPartForm({ ...valid, submit: { template: huge } })).toEqual({ ok: false });
  });
});