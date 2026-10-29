import { describe, expect, it } from "vitest";
import type { BrowserProfile } from "../../api";
import { browserLoginRow, deleteWarning, whereLabel } from "./browserLoginsModel";

const NOW = Date.parse("2030-01-02T00:00:00.000Z");
const profile = (over: Partial<BrowserProfile> = {}): BrowserProfile => ({
  name: "acct",
  scope: "local",
  sites: ["indeed.com"],
  login_where: "host_browser",
  last_login_at: "2030-01-01T23:00:00.000Z",
  last_verified_at: null,
  last_used_at: "2030-01-01T23:59:30.000Z",
  pinned: null,
  in_use: null,
  ...over,
});

describe("browserLoginRow", () => {
  it("summarises sites, where the login was made, and when", () => {
    const row = browserLoginRow(profile(), NOW);
    expect(row).toMatchObject({ name: "acct", sites: "indeed.com", where: "Host's browser", loggedIn: "1 h ago", lastUsed: "just now", pin: null, busy: null, canDelete: true });
  });

  it("says so when nothing is recorded", () => {
    const row = browserLoginRow(profile({ sites: [], login_where: null, last_login_at: null, last_used_at: null }), NOW);
    expect(row).toMatchObject({ sites: "No site recorded yet", where: "Not recorded", loggedIn: "—", lastUsed: "never" });
    expect(browserLoginRow(profile({ last_login_at: null, last_verified_at: "2030-01-01T23:00:00.000Z" }), NOW).loggedIn).toBe("verified 1 h ago");
  });

  it("offers Switch back only for a pin the Host learned, not one set in Host config", () => {
    const learned = browserLoginRow(profile({ pinned: { by: "learned", reason: "a stage reported that the site blocked this browser", at: "2030-01-01T00:00:00.000Z" } }), NOW);
    expect(learned.pin).toMatchObject({ label: "Uses your Chrome", canUnpin: true });
    expect(learned.pin!.detail).toContain("site blocked this browser");
    const config = browserLoginRow(profile({ pinned: { by: "config", reason: "x", at: null } }), NOW);
    expect(config.pin).toMatchObject({ canUnpin: false });
    expect(config.pin!.detail).toContain("browser.profile_hosts");
  });

  it("blocks Delete while a live run holds the profile, but not for a finished run's stale lock", () => {
    const live = browserLoginRow(profile({ in_use: { run_id: "2030-run-abcdef", stage_id: "s", live: true } }), NOW);
    expect(live).toMatchObject({ canDelete: false, busy: "In use by run abcdef" });
    const stale = browserLoginRow(profile({ in_use: { run_id: "2030-run-abcdef", stage_id: null, live: false } }), NOW);
    expect(stale).toMatchObject({ canDelete: true, busy: "Held by finished run abcdef" });
  });
});

describe("deleteWarning", () => {
  it("always says Delete is not a site logout", () => {
    const lines = deleteWarning(profile());
    expect(lines[1]).toContain("does not sign you out on the site");
    expect(lines).toHaveLength(2);
  });

  it("adds that a login in your own Chrome cannot be removed from here", () => {
    expect(deleteWarning(profile({ login_where: "own_chrome" })).join(" ")).toContain("lives in that browser");
    expect(deleteWarning(profile({ pinned: { by: "learned", reason: "x", at: null } })).join(" ")).toContain("Stageflow cannot remove it");
  });

  it("names the places a login can live", () => {
    expect(whereLabel("own_chrome")).toBe("Your Chrome");
    expect(whereLabel("host_browser")).toBe("Host's browser");
    expect(whereLabel(null)).toBe("Not recorded");
  });
});
