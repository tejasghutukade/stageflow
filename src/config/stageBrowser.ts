import type { StageBrowserConfig } from "../types/stage.js";
import { loadFailure, loadSuccess, type LoadOutcome } from "./loadOutcome.js";
import { mergeToolRequires, type ToolRequirement } from "./toolRequires.js";

export const BROWSER_TOOL_NAME = "agent-browser";

const ALLOWED_KEYS = new Set(["profile", "headed", "allow_domains", "login_url", "check"]);
const CHECK_KEYS = new Set(["url", "logged_in_url", "logged_out_url"]);
const REJECTED_KEYS = new Set(["path", "scope", "secret"]);
const HOST_ONLY_KEYS = new Set([
  "launch_args",
  "args",
  "executable_path",
  "executable",
  "display",
  "headless",
  "xvfb",
  "env",
]);
const PROFILE_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const DOMAIN =
  /^(\*\.)?[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(
  label: string,
  stageId: string | undefined,
  message: string,
): LoadOutcome<never> {
  return loadFailure([
    {
      code: "stage.invalid_browser",
      message: `Invalid stage ${label}: browser ${message}`,
      category: "stage",
      ...(stageId !== undefined ? { stageId } : {}),
    },
  ]);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function parseCheck(
  raw: unknown,
  label: string,
  stageId: string | undefined,
): LoadOutcome<NonNullable<StageBrowserConfig["check"]>> {
  if (!isPlainObject(raw)) {
    return fail(label, stageId, "check must be an object");
  }
  for (const key of Object.keys(raw)) {
    if (!CHECK_KEYS.has(key)) {
      return fail(
        label,
        stageId,
        `check unknown key "${key}" (allowed: url, logged_in_url, logged_out_url)`,
      );
    }
  }
  if (!nonEmptyString(raw.url)) {
    return fail(label, stageId, "check.url must be a non-empty string");
  }
  const check: NonNullable<StageBrowserConfig["check"]> = {
    url: raw.url.trim(),
  };
  if (raw.logged_in_url !== undefined) {
    if (!nonEmptyString(raw.logged_in_url)) {
      return fail(
        label,
        stageId,
        "check.logged_in_url must be a non-empty string",
      );
    }
    check.logged_in_url = raw.logged_in_url.trim();
  }
  if (raw.logged_out_url !== undefined) {
    const list = Array.isArray(raw.logged_out_url)
      ? raw.logged_out_url
      : [raw.logged_out_url];
    if (list.length === 0 || !list.every(nonEmptyString)) {
      return fail(
        label,
        stageId,
        "check.logged_out_url must be a non-empty string or a non-empty list of strings",
      );
    }
    const trimmed = list.map((item) => (item as string).trim());
    check.logged_out_url = Array.isArray(raw.logged_out_url)
      ? trimmed
      : trimmed[0];
  }
  return loadSuccess(check);
}

export function parseStageBrowser(
  raw: unknown,
  label: string,
  stageId?: string,
): LoadOutcome<StageBrowserConfig | undefined> {
  if (raw === undefined) return loadSuccess(undefined);
  if (!isPlainObject(raw)) {
    return fail(label, stageId, "must be an object");
  }
  for (const key of Object.keys(raw)) {
    if (REJECTED_KEYS.has(key)) {
      return fail(
        label,
        stageId,
        `"${key}" is not allowed (the Host chooses profile location and scope)`,
      );
    }
    if (HOST_ONLY_KEYS.has(key)) {
      return fail(
        label,
        stageId,
        `"${key}" is not allowed (browser launch options are Host config: browser.launch_args and browser.executable_path in $STAGEFLOW_HOME/config.yaml)`,
      );
    }
    if (!ALLOWED_KEYS.has(key)) {
      return fail(
        label,
        stageId,
        `unknown key "${key}" (allowed: profile, headed, allow_domains, login_url, check)`,
      );
    }
  }

  const browser: StageBrowserConfig = {};

  if (raw.profile !== undefined) {
    if (typeof raw.profile !== "string" || !PROFILE_NAME.test(raw.profile)) {
      return fail(
        label,
        stageId,
        "profile must be 1-64 characters of letters, digits, dash, or underscore",
      );
    }
    browser.profile = raw.profile;
  }

  if (raw.headed !== undefined) {
    if (typeof raw.headed !== "boolean") {
      return fail(label, stageId, "headed must be a boolean");
    }
    browser.headed = raw.headed;
  }

  if (raw.allow_domains !== undefined) {
    if (!Array.isArray(raw.allow_domains) || raw.allow_domains.length === 0) {
      return fail(
        label,
        stageId,
        "allow_domains must be a non-empty array of domain names",
      );
    }
    const domains: string[] = [];
    for (const item of raw.allow_domains) {
      if (typeof item !== "string" || !DOMAIN.test(item.trim())) {
        return fail(
          label,
          stageId,
          `allow_domains entry ${JSON.stringify(item)} must be a bare domain such as "example.com" or "*.example.com" (no scheme, port, or path)`,
        );
      }
      domains.push(item.trim());
    }
    browser.allow_domains = domains;
  }

  if (raw.login_url !== undefined) {
    if (!nonEmptyString(raw.login_url)) {
      return fail(label, stageId, "login_url must be a non-empty string");
    }
    browser.login_url = raw.login_url.trim();
  }

  if (raw.check !== undefined) {
    const check = parseCheck(raw.check, label, stageId);
    if (!check.ok) return check;
    browser.check = check.value;
  }

  return loadSuccess(browser);
}

export function withBrowserRequires(
  stage: { browser?: StageBrowserConfig; requires?: ToolRequirement[] },
  ctx: { pipelineId: string; stageId: string },
): LoadOutcome<ToolRequirement[] | undefined> {
  if (stage.browser === undefined) return loadSuccess(stage.requires);
  return mergeToolRequires(
    [stage.requires, [{ tool: BROWSER_TOOL_NAME }]],
    { pipelineId: ctx.pipelineId, label: `stage "${ctx.stageId}"` },
  );
}
