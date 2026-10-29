import { describe, expect, it } from "vitest";
import type { BrowserProfile } from "../../api";
import { browserLoginRow, checkResultText, deleteWarning, loginInstructions, stillWaitingText, whereLabel } from "./browserLoginsModel";

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
  can_check: true,
  logging_in: false,
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

describe("Check now and Log in again", () => {
  it("are available once a check is recorded and no live run holds the login", () => {
    expect(browserLoginRow(profile(), NOW)).toMatchObject({ canCheck: true, loggingIn: false, actionHint: null });
    const waiting = browserLoginRow(profile({ logging_in: true, in_use: { run_id: "cli-7-abcdef", stage_id: "browser-profiles", live: true } }), NOW);
    expect(waiting).toMatchObject({ loggingIn: true, busy: "Waiting for you to log in", canDelete: false });
  });

  it("explain why they are off", () => {
    const none = browserLoginRow(profile({ can_check: false }), NOW);
    expect(none).toMatchObject({ canCheck: false });
    expect(none.actionHint).toContain("Run a pipeline that uses this login once");
    const busy = browserLoginRow(profile({ in_use: { run_id: "x-run-abcdef", stage_id: null, live: true } }), NOW);
    expect(busy).toMatchObject({ canCheck: false, actionHint: "A run is using this login." });
  });

  it("word the check result for each state, naming the site", () => {
    expect(checkResultText("logged_in", "indeed.com")).toEqual({ tone: "ok", text: "Still logged in to indeed.com." });
    expect(checkResultText("logged_out", "indeed.com")).toMatchObject({ tone: "needs", text: "Logged out of indeed.com. Use Log in again." });
    expect(checkResultText("unknown", null).tone).toBe("muted");
    expect(checkResultText("logged_in", null).text).toBe("Still logged in.");
  });

  it("tell the operator where the login page opened", () => {
    expect(loginInstructions("own_chrome", "indeed.com")).toContain("opened in your Chrome");
    expect(loginInstructions("host_window", null)).toContain("computer running Stageflow");
    expect(loginInstructions(null, "indeed.com")).toContain("indeed.com");
    expect(loginInstructions("own_chrome", "x.test")).toContain("I've logged in");
  });

  it("explain a login that is not confirmed yet", () => {
    expect(stillWaitingText({ state: "logged_out" })).toContain("still sees a logged-out page");
    expect(stillWaitingText({ state: "unknown" })).toContain("could not confirm");
  });
});
