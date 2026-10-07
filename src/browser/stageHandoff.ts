import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { stageDir } from "../runstore/paths.js";
import type { StageBrowserConfig } from "../types/stage.js";
import type { StageBrowserSupport } from "./browserHost.js";
import {
  browserSite,
  type GateHandoff,
  type HostGateContext,
} from "./gateHandoff.js";
import {
  resolveBrowserHostCapabilities,
  type BrowserHostCapabilities,
} from "./hostCapabilities.js";
import { defaultDisplayProbe, noScreenError } from "./humanLogin.js";

const BROWSER_CAPABILITIES_FILENAME = "browser-capabilities.json";

/** The slice of the host capability record a stage's handoff depends on; persisted per stage. */
export type StageHandoffCapabilities = Pick<BrowserHostCapabilities, "display" | "liveView">;

type HandoffInput = { runDir: string; runId: string; stageId: string };

/**
 * Probes the display, applies the host's capabilities, and rejects a human-login
 * stage that has neither a screen nor a live view. Pure of disk writes.
 */
export function resolveStageHandoffCapabilities(
  support: StageBrowserSupport,
  options: { humanLogin?: boolean } = {},
): StageHandoffCapabilities {
  const capabilities = resolveBrowserHostCapabilities(support.host.capabilities);
  const probe = support.display ?? defaultDisplayProbe;
  if (support.host.capabilities === undefined) {
    capabilities.display = probe().hasDisplay ? "local_window" : "headless_only";
  } else if (capabilities.display === "local_window" && support.display !== undefined && !support.display().hasDisplay) {
    capabilities.display = "headless_only";
  }
  if (
    options.humanLogin === true &&
    capabilities.display === "headless_only" &&
    capabilities.liveView === "none"
  ) {
    throw noScreenError(probe().docker);
  }
  return { display: capabilities.display, liveView: capabilities.liveView };
}

export async function persistStageHandoff(
  input: { runDir: string; stageId: string },
  capabilities: StageHandoffCapabilities,
): Promise<void> {
  const dir = stageDir(input.runDir, input.stageId);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, BROWSER_CAPABILITIES_FILENAME),
    `${JSON.stringify({ display: capabilities.display, liveView: capabilities.liveView })}\n`,
    { mode: 0o600 },
  );
}

/** Persisted capabilities of a stage; undefined when none were recorded (older runs, direct stage runs). */
export async function readStageHandoff(input: {
  runDir: string;
  stageId: string;
}): Promise<StageHandoffCapabilities | undefined> {
  const file = path.join(stageDir(input.runDir, input.stageId), BROWSER_CAPABILITIES_FILENAME);
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const { display, liveView } = resolveBrowserHostCapabilities(parsed as Partial<BrowserHostCapabilities>);
      return { display, liveView };
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  return undefined;
}

export function gateHandoffFor(context: {
  runId: string;
  stageId: string;
  capabilities: StageHandoffCapabilities;
}): GateHandoff | undefined {
  const { capabilities } = context;
  if (capabilities.display === "local_window") return { kind: "local_window" };
  if (capabilities.liveView !== "none") {
    return {
      kind: "live_view",
      url: `/api/runs/${encodeURIComponent(context.runId)}/stages/${encodeURIComponent(context.stageId)}/live-view`,
    };
  }
  return undefined;
}

/** What the Host stamps on every gate of a browser stage; the agent cannot supply it. */
export function hostGateContextFor(
  browser: StageBrowserConfig | undefined,
  context: { runId: string; stageId: string; capabilities: StageHandoffCapabilities },
): HostGateContext | undefined {
  if (browser === undefined) return undefined;
  const site = browserSite(browser);
  const handoff = gateHandoffFor(context);
  return {
    ...(handoff !== undefined ? { handoff } : {}),
    ...(site !== undefined ? { site } : {}),
    ...(browser.profile !== undefined ? { profile: browser.profile } : {}),
  };
}

// No record (older runs, direct stage runs) keeps its historical meaning: a local window.
const LEGACY_CAPABILITIES: StageHandoffCapabilities = { display: "local_window", liveView: "none" };

async function capabilitiesOf(input: HandoffInput & { dirStageId?: string }): Promise<StageHandoffCapabilities> {
  return (
    (await readStageHandoff({ runDir: input.runDir, stageId: input.dirStageId ?? input.stageId })) ??
    LEGACY_CAPABILITIES
  );
}

/** The handoff for a stage's gates and login prompt. `dirStageId` is the manifest id when it differs from the gate's stage id. */
export async function stageGateHandoff(
  input: HandoffInput & { dirStageId?: string },
): Promise<GateHandoff | undefined> {
  return gateHandoffFor({
    runId: input.runId,
    stageId: input.stageId,
    capabilities: await capabilitiesOf(input),
  });
}

/** Host-owned gate fields for a stage; undefined for a stage without a browser. */
export async function stageGateContext(
  input: HandoffInput & { browser: StageBrowserConfig | undefined },
): Promise<HostGateContext | undefined> {
  if (input.browser === undefined) return undefined;
  return hostGateContextFor(input.browser, {
    runId: input.runId,
    stageId: input.stageId,
    capabilities: await capabilitiesOf(input),
  });
}
