import type { BrowserProfile } from "../../api";

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
    busy: profile.in_use === null ? null : `${live ? "In use by" : "Held by finished"} run ${profile.in_use.run_id.slice(-6)}`,
    canDelete: !live,
    deleteWarning: deleteWarning(profile),
  };
}
