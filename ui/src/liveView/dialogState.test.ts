import { describe, expect, it } from "vitest";
import {
  applyDialogClosed,
  buildDialogAnswer,
  canAnswer,
  dialogOutcome,
  DIALOG_TIMEOUT_NOTICE,
  parseDialogOpened,
} from "./dialogState";

const confirm = { id: "d1", kind: "confirm", message: "<b>Sure?</b>", defaultPrompt: "", targetId: "t", answerable: true };

describe("dialog state", () => {
  it("parses a dialog and keeps the message as plain text", () => {
    expect(parseDialogOpened(confirm)).toEqual({
      id: "d1",
      kind: "confirm",
      message: "<b>Sure?</b>",
      defaultPrompt: "",
      answerable: true,
      autoClosed: false,
    });
  });

  it("rejects malformed payloads and never trusts answerable for alerts", () => {
    expect(parseDialogOpened(undefined)).toBeUndefined();
    expect(parseDialogOpened({ id: "x", kind: "weird" })).toBeUndefined();
    expect(parseDialogOpened({ ...confirm, id: 4 })).toBeUndefined();
    expect(parseDialogOpened({ ...confirm, kind: "alert" })?.answerable).toBe(false);
    expect(parseDialogOpened({ ...confirm, answerable: false })?.answerable).toBe(false);
  });

  it("closes an answerable dialog, with a notice only for a time-out", () => {
    const d = parseDialogOpened(confirm)!;
    expect(applyDialogClosed(d, { id: "d1", result: "accepted" })).toEqual({ dialog: null, notice: null, linger: false });
    expect(applyDialogClosed(d, { id: "d1", result: "timeout" })).toEqual({
      dialog: null,
      notice: DIALOG_TIMEOUT_NOTICE,
      linger: false,
    });
  });

  it("ignores a close for another dialog or when none is open", () => {
    const d = parseDialogOpened(confirm)!;
    expect(applyDialogClosed(d, { id: "d9", result: "timeout" }).dialog).toBe(d);
    expect(applyDialogClosed(null, { id: "d1", result: "timeout" }).dialog).toBeNull();
    expect(applyDialogClosed(d, "nope").dialog).toBe(d);
  });

  it("keeps a read-only dialog visible after it closes", () => {
    const d = parseDialogOpened({ ...confirm, kind: "alert", answerable: false })!;
    const out = applyDialogClosed(d, { id: "d1", result: "accepted" });
    expect(out.dialog).toMatchObject({ id: "d1", autoClosed: true });
    expect(out.linger).toBe(true);
    expect(canAnswer(out.dialog!, "control")).toBe(false);
  });

  it("offers answers only to control mode on answerable dialogs", () => {
    const d = parseDialogOpened(confirm)!;
    expect(canAnswer(d, "control")).toBe(true);
    expect(canAnswer(d, "view")).toBe(false);
    expect(canAnswer({ ...d, answerable: false }, "control")).toBe(false);
  });

  it("builds answer bodies: text only for an accepted prompt, clipped", () => {
    const prompt = parseDialogOpened({ ...confirm, kind: "prompt", defaultPrompt: "dflt" })!;
    expect(buildDialogAnswer(prompt, true, "hi")).toEqual({ id: "d1", accept: true, promptText: "hi" });
    expect(buildDialogAnswer(prompt, false, "hi")).toEqual({ id: "d1", accept: false });
    expect(buildDialogAnswer(prompt, true, "x".repeat(5000)).promptText).toHaveLength(2000);
    expect(buildDialogAnswer(parseDialogOpened(confirm)!, true, "ignored")).toEqual({ id: "d1", accept: true });
  });

  it("maps response status to an outcome", () => {
    expect(dialogOutcome(200)).toBe("answered");
    expect(dialogOutcome(409)).toBe("gone");
    expect(dialogOutcome(403)).toBe("failed");
    expect(dialogOutcome(400)).toBe("failed");
  });
});
