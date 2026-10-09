import { existsSync } from "node:fs";
import type { ResolvedPipelineDag } from "../types/pipeline.js";
import type { StageBrowserConfig } from "../types/stage.js";

export type DisplayProbe = () => { hasDisplay: boolean; docker: boolean };

export const NO_SCREEN_MESSAGE =
  "A visible browser is needed for login, but this Host has no screen and no live view.";
export const DOCKER_HINT =
  " This Host runs in Docker: run the login stage on a machine with a screen, or log in there first and reuse the profile.";

/**
 * A human login stage is a stage with a `browser` whose after-phase verify
 * contains a `browser_login` item. The Host opens the login page in a visible
 * window and the agent only asks the operator to confirm.
 */
export function isHumanLoginStage(
  dag: Pick<ResolvedPipelineDag, "nodes"> | undefined,
  stageId: string,
  browser: StageBrowserConfig | undefined,
): boolean {
  if (browser === undefined || dag === undefined) return false;
  const node = dag.nodes.find((n) => n.id === stageId);
  return node?.completion?.checks.some((c) => c.type === "browser_login") === true;
}

export function loginPageUrl(browser: StageBrowserConfig): string | undefined {
  return browser.login_url ?? browser.check?.url;
}

export function defaultDisplayProbe(
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
): ReturnType<DisplayProbe> {
  const docker = existsSync("/.dockerenv") || Boolean(env.container) || env.STAGEFLOW_IN_DOCKER === "1";
  const hasDisplay =
    platform !== "linux" || Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
  return { hasDisplay, docker };
}

export function noScreenError(docker: boolean): Error {
  return new Error(`${NO_SCREEN_MESSAGE}${docker ? DOCKER_HINT : ""}`);
}

export function humanLoginPromptBlock(
  url: string | undefined,
  handoff: "local_window" | "live_view" = "local_window",
): string {
  if (handoff === "live_view") {
    return [
      "## Human login",
      "",
      `The Host has opened ${url !== undefined ? JSON.stringify(url) : "the login page"} in a browser the operator can see through the live view shown in the console in this gate.`,
      "Do not type credentials and do not drive the browser. Call ask_operator with kind confirm: ask the operator to log in through the live view and confirm when done. Leave the browser open.",
      "After the operator accepts, emit the envelope. The Host re-checks the login itself; if it still sees a logged-out session, this stage runs again.",
    ].join("\n");
  }
  return [
    "## Human login",
    "",
    `The Host has opened ${url !== undefined ? JSON.stringify(url) : "the login page"} in a visible browser window on the operator's screen.`,
    "Do not type credentials and do not drive the browser. Call ask_operator with kind confirm: ask the operator to log in in that window and confirm when done. Leave the browser open.",
    "After the operator accepts, emit the envelope. The Host re-checks the login itself; if it still sees a logged-out session, this stage runs again.",
  ].join("\n");
}
