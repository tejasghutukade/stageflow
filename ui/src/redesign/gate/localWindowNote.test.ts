import { describe, expect, it } from "vitest";
import { localWindowNote } from "./BrowserHandoff";

describe("localWindowNote", () => {
  it("tells an attached operator to use their own Chrome and names the site", () => {
    const note = localWindowNote(true, "www.indeed.com");
    expect(note.title).toBe("Use your own Chrome");
    expect(note.body).toContain("www.indeed.com");
    expect(note.body).toContain("never closes");
  });

  it("points to the Host's computer for a normal window, with or without a site", () => {
    expect(localWindowNote(false, undefined).title).toBe("Use the browser window on this computer");
    expect(localWindowNote(false, undefined).body).not.toContain("(");
  });
});
