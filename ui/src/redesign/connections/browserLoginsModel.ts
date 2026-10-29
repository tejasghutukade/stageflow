import type { BrowserLoginFinish, BrowserLoginState, BrowserLoginStart, BrowserProfile } from "../../api";

export type BrowserLoginRow = {
  name: string;
  sites: string;
  where: string;
  loggedIn: string;
  lastUsed: string;
  pin: { label: string; detail: string; canUnpin: boolean } | null;
  busy: string | null;
  canDelete: boolean;
  deleteWarning: string[];
  canCheck: boolean;
  loggingIn: boolean;
  /** Why Check now and Log in again are off, when they are. */
  actionHint: string | null;
};

function age(iso: string | null, now: number): string {
  if (iso === null) return "never";
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (Number.isNaN(seconds)) return "never";
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  return `${Math.floor(seconds / 86400)} d ago`;
}

export function whereLabel(where: BrowserProfile["login_where"]): string {
  return where === "own_chrome" ? "Your Chrome" : where === "host_browser" ? "Host's browser" : "Not recorded";
}

/** What deleting does and does not do, in the order the operator should read it. */
export function deleteWarning(profile: BrowserProfile): string[] {
  const lines = [
    `Deletes the login data Stageflow's own browser holds for "${profile.name}". Its stages will ask you to log in again.`,
    "This does not sign you out on the site. The session stays valid there until you sign out in the site's own account settings.",
  ];
  if (profile.login_where === "own_chrome" || profile.pinned !== null) {
    lines.push("A login made in your own Chrome lives in that browser. Stageflow cannot remove it; sign out in Chrome if you want it gone.");
  }
  return lines;
}

export function browserLoginRow(profile: BrowserProfile, now: number): BrowserLoginRow {
  const live = profile.in_use?.live === true;
  return {
    name: profile.name,
    sites: profile.sites.length > 0 ? profile.sites.join(", ") : "No site recorded yet",
    where: whereLabel(profile.login_where),
    loggedIn: profile.last_login_at !== null ? age(profile.last_login_at, now) : profile.last_verified_at !== null ? `verified ${age(profile.last_verified_at, now)}` : "—",
    lastUsed: age(profile.last_used_at, now),
    pin:
      profile.pinned === null
        ? null
        : profile.pinned.by === "config"
          ? { label: "Uses your Chrome", detail: "Pinned in Host config (browser.profile_hosts). Change it there.", canUnpin: false }
          : { label: "Uses your Chrome", detail: `The Host learned this: ${profile.pinned.reason}.`, canUnpin: true },
    busy:
      profile.logging_in
        ? "Waiting for you to log in"
        : profile.in_use === null
          ? null
          : `${live ? "In use by" : "Held by finished"} run ${profile.in_use.run_id.slice(-6)}`,
    canDelete: !live && !profile.logging_in,
    deleteWarning: deleteWarning(profile),
    canCheck: profile.can_check && !live,
    loggingIn: profile.logging_in,
    actionHint: !profile.can_check ? "Run a pipeline that uses this login once, and Check now and Log in again will appear." : live ? "A run is using this login." : null,
  };
}

/** What the Host saw when it checked the login now. */
export function checkResultText(state: BrowserLoginState, site: string | null): { tone: "ok" | "needs" | "muted"; text: string } {
  const where = site !== null ? ` to ${site}` : "";
  if (state === "logged_in") return { tone: "ok", text: `Still logged in${where}.` };
  if (state === "logged_out") return { tone: "needs", text: `Logged out${site !== null ? ` of ${site}` : ""}. Use Log in again.` };
  return { tone: "muted", text: "Could not tell. The site may be showing a check the Host's browser cannot pass. Try Log in again." };
}

/** What the operator does after Log in again opened a page. */
export function loginInstructions(where: BrowserLoginStart["where"] | null, site: string | null): string {
  const on = site !== null ? ` for ${site}` : "";
  if (where === "own_chrome") return `A new tab${on} opened in your Chrome. Log in there, then press "I've logged in".`;
  if (where === "host_window") return `A browser window${on} opened on the computer running Stageflow. Log in there, then press "I've logged in".`;
  return `Log in in the tab Stageflow opened${on}, then press "I've logged in".`;
}

/** Message after "I've logged in" when the Host still sees a logged-out page. */
export function stillWaitingText(result: Pick<BrowserLoginFinish, "state">): string {
  return result.state === "unknown"
    ? "The Host could not confirm the login yet. Finish any check on the page, then try again."
    : "The Host still sees a logged-out page. Finish logging in, then try again.";
}
