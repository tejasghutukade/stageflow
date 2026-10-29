import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { StageBrowserConfig } from "../types/stage.js";
import { hostOf } from "./sitePolicy.js";
import type { ProfileHandle } from "./profileStore.js";

/** Where the login a profile holds was made: in the Host's own browser, or in the operator's own Chrome. */
export type LoginWhere = "host_browser" | "own_chrome";

/** What the console may show about a profile. Never a cookie, token or path. */
/** How to tell whether the profile is logged in (the stage's own `check`) and where to log in. URLs and globs only. */
export type ProfileRecipe = {
  check?: { url: string; logged_in_url?: string; logged_out_url?: string | string[] };
  login_url?: string;
};

export type ProfileMeta = ProfileRecipe & {
  sites: string[];
  last_login_at?: string;
  last_verified_at?: string;
  login_where?: LoginWhere;
};

export interface ProfileMetaStore {
  get(profile: ProfileHandle): Promise<ProfileMeta | undefined>;
  /** Merges `patch` into the stored record: sites are unioned, times and `login_where` are replaced when given. */
  record(profile: ProfileHandle, patch: { sites?: readonly string[]; login_at?: string; verified_at?: string; where?: LoginWhere } & ProfileRecipe): Promise<void>;
  clear(profile: ProfileHandle): Promise<void>;
}

const META_FILENAME = "meta.json";
const MAX_SITES = 20;

/** The sites a stage's `browser` block says it works with, as bare host names. */
export function stageSites(browser: StageBrowserConfig | undefined): string[] {
  if (browser === undefined) return [];
  const sites = new Set<string>();
  const add = (host: string | undefined) => {
    if (host !== undefined && host !== "") sites.add(host.toLowerCase());
  };
  if (browser.check !== undefined) add(hostOf(browser.check.url));
  if (browser.login_url !== undefined) add(hostOf(browser.login_url));
  for (const domain of browser.allow_domains ?? []) add(domain.replace(/^\*\./, ""));
  return [...sites];
}

function merge(current: ProfileMeta | undefined, patch: Parameters<ProfileMetaStore["record"]>[1]): ProfileMeta {
  const sites = [...new Set([...(current?.sites ?? []), ...(patch.sites ?? [])])].slice(0, MAX_SITES);
  return {
    sites,
    ...(patch.login_at !== undefined ? { last_login_at: patch.login_at } : current?.last_login_at !== undefined ? { last_login_at: current.last_login_at } : {}),
    ...(patch.verified_at !== undefined ? { last_verified_at: patch.verified_at } : current?.last_verified_at !== undefined ? { last_verified_at: current.last_verified_at } : {}),
    ...(patch.where !== undefined ? { login_where: patch.where } : current?.login_where !== undefined ? { login_where: current.login_where } : {}),
    ...(patch.check !== undefined ? { check: patch.check } : current?.check !== undefined ? { check: current.check } : {}),
    ...(patch.login_url !== undefined ? { login_url: patch.login_url } : current?.login_url !== undefined ? { login_url: current.login_url } : {}),
  };
}

function parseCheck(raw: unknown): ProfileRecipe["check"] | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.url !== "string") return undefined;
  const out: NonNullable<ProfileRecipe["check"]> = { url: r.url };
  if (typeof r.logged_in_url === "string") out.logged_in_url = r.logged_in_url;
  if (typeof r.logged_out_url === "string") out.logged_out_url = r.logged_out_url;
  else if (Array.isArray(r.logged_out_url) && r.logged_out_url.every((x) => typeof x === "string")) out.logged_out_url = r.logged_out_url as string[];
  return out;
}

function parse(raw: unknown): ProfileMeta | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const sites = Array.isArray(r.sites) ? r.sites.filter((s): s is string => typeof s === "string").slice(0, MAX_SITES) : [];
  return {
    sites,
    ...(typeof r.last_login_at === "string" ? { last_login_at: r.last_login_at } : {}),
    ...(typeof r.last_verified_at === "string" ? { last_verified_at: r.last_verified_at } : {}),
    ...(r.login_where === "host_browser" || r.login_where === "own_chrome" ? { login_where: r.login_where } : {}),
    ...(parseCheck(r.check) !== undefined ? { check: parseCheck(r.check)! } : {}),
    ...(typeof r.login_url === "string" ? { login_url: r.login_url } : {}),
  };
}

/** Metadata in the profile's state folder when it has one, else in memory for this process. */
export function createProfileMetaStore(): ProfileMetaStore {
  const memory = new Map<string, ProfileMeta>();
  const keyOf = (p: ProfileHandle) => `${p.key.scope}\0${p.key.name}`;
  const fileOf = (p: ProfileHandle) => (p.stateDir !== undefined ? path.join(p.stateDir, META_FILENAME) : undefined);

  async function read(profile: ProfileHandle): Promise<ProfileMeta | undefined> {
    const file = fileOf(profile);
    if (file === undefined) return memory.get(keyOf(profile));
    try {
      return parse(JSON.parse(await readFile(file, "utf8")));
    } catch {
      return undefined;
    }
  }

  return {
    get: read,
    async record(profile, patch) {
      const next = merge(await read(profile), patch);
      const file = fileOf(profile);
      if (file === undefined) {
        memory.set(keyOf(profile), next);
        return;
      }
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, `${JSON.stringify(next)}\n`, { mode: 0o600 });
      await rename(tmp, file);
    },
    async clear(profile) {
      memory.delete(keyOf(profile));
      const file = fileOf(profile);
      if (file !== undefined) await rm(file, { force: true });
    },
  };
}

let shared: ProfileMetaStore | undefined;

/** One store for the Host process (stage start, login completion, the API and the CLI all use it). */
export function defaultProfileMetaStore(): ProfileMetaStore {
  shared ??= createProfileMetaStore();
  return shared;
}

/** Best effort: bookkeeping about a profile must never fail a run. */
export async function recordProfileSession(
  profile: ProfileHandle,
  patch: Parameters<ProfileMetaStore["record"]>[1],
  store: ProfileMetaStore = defaultProfileMetaStore(),
): Promise<void> {
  await store.record(profile, patch).catch(() => undefined);
}
