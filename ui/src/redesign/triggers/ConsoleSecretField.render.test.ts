import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ConsoleSecretField } from "./NewTriggerModal";
import type { TriggerSecretState } from "./newTriggerModel";

const noop = () => undefined;
const render = (secret: TriggerSecretState, isEdit = true) =>
  renderToStaticMarkup(createElement(ConsoleSecretField, { secret, isEdit, onChange: noop }));

describe("ConsoleSecretField", () => {
  it("shows a set badge with Replace and Clear and no input", () => {
    const html = render({ value: "", set: true, replacing: false, clear: false });
    expect(html).toContain(">set<");
    expect(html).toContain("Replace");
    expect(html).toContain("Clear");
    expect(html).not.toContain("<input");
  });

  it("shows a masked empty field when not set, and never renders a typed value", () => {
    const html = render({ value: "typed-secret-xyz", set: false, replacing: false, clear: false }, false);
    expect(html).toContain('type="password"');
    expect(html).not.toContain(">set<");
    expect(html).not.toContain("Replace");
  });

  it("shows the masked field with Cancel while replacing and an Undo while clearing", () => {
    expect(render({ value: "", set: true, replacing: true, clear: false })).toContain("Cancel");
    const cleared = render({ value: "", set: true, replacing: false, clear: true });
    expect(cleared).toContain("Undo");
    expect(cleared).toContain("cleared on save");
  });
});
