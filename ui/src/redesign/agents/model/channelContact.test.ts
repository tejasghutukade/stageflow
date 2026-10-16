import { describe, expect, it } from "vitest";
import { contactLines } from "./channelContact";

const shared = {
  ok: true as const,
  kind: "shared" as const,
  users: [
    { phone: "+1 415 555 0123", assignedNumber: "+19998887777", name: "Jane Doe" },
    { phone: "+14155550124", assignedNumber: null, name: null },
  ],
};

describe("contact lines", () => {
  it("tells which dedicated number to text", () => {
    expect(contactLines({ ok: true, kind: "dedicated", numbers: ["+14155550001"] }, [])).toEqual([{ tone: "ok", text: "Text +14155550001 to reach this agent." }]);
    expect(contactLines({ ok: true, kind: "dedicated", numbers: ["+1", "+2"] }, [])[0]!.text).toBe("Text any of +1, +2 to reach this agent.");
    expect(contactLines({ ok: true, kind: "dedicated", numbers: [] }, [])[0]!.tone).toBe("muted");
  });

  it("matches each allowed phone with the number it was assigned, and flags the unregistered", () => {
    const lines = contactLines(shared, ["+14155550123", "+14155550124", "+14155550999", "jane@x.com"]);
    expect(lines.map((l) => [l.tone, l.text])).toEqual([
      ["ok", "Jane Doe (+14155550123) texts +19998887777."],
      ["warn", "+14155550124 is registered but has no number assigned yet."],
      ["warn", "+14155550999 is not registered in your Photon project, so it cannot text this agent. Add it as a user in the Photon dashboard."],
      ["muted", "On a shared line each person texts the number Photon assigned to them, and must text it once before the agent can answer."],
    ]);
  });

  it("lists registered users when the allow-list names no phones, and says when there are none", () => {
    expect(contactLines(shared, ["*"])[0]).toEqual({ tone: "ok", text: "Jane Doe (+1 415 555 0123) texts +19998887777." });
    expect(contactLines({ ok: true, kind: "shared", users: [] }, ["*"])[0]!.tone).toBe("warn");
  });

  it("explains a failed lookup", () => {
    expect(contactLines({ ok: false, error: "Photon answered 401" }, [])).toEqual([{ tone: "muted", text: "Could not look up the number: Photon answered 401" }]);
  });
});
