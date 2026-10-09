/**
 * Cursor-only StageProviderSupport for pi-cursor-sdk.
 *
 * Loaded only when stage.model is `cursor/...`. Other providers never hit this
 * module's prepare()/env sealing path.
 */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readSecretFromEnvOrFile } from "../config/secretFromEnvOrFile.js";
import {
  globalCredentialRoot,
  globalStageflowHome,
} from "../project/globalHome.js";
import {
  registerProviderSupport,
  type ProviderPrepareResult,
  type StageProviderSupport,
} from "./providerSupport.js";

const CURSOR_SETTING_SOURCES_ENV = "PI_CURSOR_SETTING_SOURCES";

/**
 * Locate the pi-cursor-sdk extension entry without opening full global package
 * discovery. Stages stay sealed; only this allowlisted path is loaded.
 *
 * Resolution order:
 * 1. STAGEFLOW_CURSOR_EXTENSION (absolute path to the extension .ts/.js)
 * 2. Path package from the Pi agent settings.json (same source interactive pi uses)
 * 3. npm dependency `pi-cursor-sdk` bundled with the Stageflow install (repo or global)
 * 4. npm install under <stageflow-agent>/npm/node_modules/pi-cursor-sdk
 *    (`dist/index.js` for 0.3+, `src/index.ts` for older publishes)
 * 5. Sibling checkout at ../pi-cursor-sdk relative to this repo
 *
 * A stage worker's HOME is an empty attempt directory. Package lookup uses
 * $STAGEFLOW_HOME/agent, not the credential root.
 */
const CURSOR_PACKAGE_ENTRIES = ["dist/index.js", "src/index.ts"] as const;

/** Stageflow agent dir ($STAGEFLOW_HOME/agent). Stage workers must not use os.homedir(): HOME is the attempt dir. */
function piAgentDir(): string {
  return path.join(globalStageflowHome(), "agent");
}

export function cursorExtensionEntryInPackage(
  packageRoot: string,
): string | undefined {
  for (const rel of CURSOR_PACKAGE_ENTRIES) {
    const full = path.join(packageRoot, rel);
    if (existsSync(full)) {
      return full;
    }
  }
  return undefined;
}

export function resolveBundledCursorExtensionPath(): string | undefined {
  const require = createRequire(import.meta.url);
  let packageRoot: string;
  try {
    packageRoot = path.dirname(require.resolve("pi-cursor-sdk/package.json"));
  } catch {
    return undefined;
  }
  return cursorExtensionEntryInPackage(packageRoot);
}

/** `$STAGEFLOW_HOME/agent/npm` install (Pi-style); after bundled dependency. */
export function resolveAgentHomeCursorExtensionPath(): string | undefined {
  return cursorExtensionEntryInPackage(
    path.join(piAgentDir(), "npm", "node_modules", "pi-cursor-sdk"),
  );
}

export function resolveCursorExtensionPath(): string | undefined {
  const fromEnv = process.env.STAGEFLOW_CURSOR_EXTENSION?.trim();
  if (fromEnv && existsSync(fromEnv)) {
    return path.resolve(fromEnv);
  }

  const fromSettings = resolveFromPiSettings();
  if (fromSettings) {
    return fromSettings;
  }

  const bundled = resolveBundledCursorExtensionPath();
  if (bundled) {
    return bundled;
  }

  const npmEntry = resolveAgentHomeCursorExtensionPath();
  if (npmEntry) {
    return npmEntry;
  }

  const here = path.dirname(fileURLToPath(import.meta.url));
  const siblingRoot = path.resolve(here, "../../../pi-cursor-sdk");
  return cursorExtensionEntryInPackage(siblingRoot);
}

export function isCursorModelRef(modelRef: string): boolean {
  const slash = modelRef.indexOf("/");
  if (slash <= 0) {
    return false;
  }
  return modelRef.slice(0, slash).toLowerCase() === "cursor";
}

function sealCursorSettingSources(): (() => void) | undefined {
  if (process.env[CURSOR_SETTING_SOURCES_ENV] !== undefined) {
    return undefined;
  }
  process.env[CURSOR_SETTING_SOURCES_ENV] = "none";
  return () => {
    delete process.env[CURSOR_SETTING_SOURCES_ENV];
  };
}

function missingExtensionReason(modelRef: string): string {
  return [
    `Model "${modelRef}" requires pi-cursor-sdk, but no extension entry was found.`,
    `Install Stageflow with npm (includes pi-cursor-sdk), or set STAGEFLOW_CURSOR_EXTENSION`,
    "to the absolute path of pi-cursor-sdk/dist/index.js (or src/index.ts).",
    "Also ensure a Cursor SDK API key is available via Pi /login or CURSOR_API_KEY.",
  ].join(" ");
}

function prepareCursor(modelRef: string): ProviderPrepareResult {
  const extensionPath = resolveCursorExtensionPath();
  if (!extensionPath) {
    return { extensionPaths: [], error: missingExtensionReason(modelRef) };
  }
  return {
    extensionPaths: [extensionPath],
    // pi-cursor-sdk defaults to settingSources ["all"]. Seal ambient Cursor
    // rules/plugins/MCP for isolated stages unless the operator already set it.
    restore: sealCursorSettingSources(),
  };
}

export function workshopCursorBridgeHint(toolNames: readonly string[]): string {
  const lines = toolNames.map(
    (name) => `- pi__${name} (playbook name: ${name})`,
  );
  return [
    "Cursor bridge: call the workshop tools by these MCP names. The playbook uses the bare names; they are the same tools.",
    ...lines,
    "When the operator asks you to create or edit the draft, do not finish without one of these tool calls.",
  ].join("\n");
}

export function cursorBridgePrompt(
  message: string,
  modelId: string | undefined,
  toolNames: readonly string[],
): string {
  if (!modelId || !isCursorModelRef(modelId) || toolNames.length === 0) {
    return message;
  }
  return `${message}\n\n${workshopCursorBridgeHint(toolNames)}`;
}

export const cursorProviderSupport: StageProviderSupport = {
  id: "cursor",
  matches: isCursorModelRef,
  prepare: prepareCursor,
  emitToolHint(toolName: string): string {
    return [
      `Required final action: call the MCP tool pi__${toolName} exactly once`,
      `(pi name: ${toolName}) with status, summary, and artifacts (run-relative paths)`,
      "and a payload matching the stage payload_schema when one is defined.",
      "Do not stop after writing files — the stage only completes when that tool returns.",
    ].join(" ");
  },
};

const CURSOR_API_KEY_FILE_NAME = "cursor-api-key";

export function readCursorApiKey(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  let fromEnv: string | undefined;
  try {
    fromEnv = readSecretFromEnvOrFile(env, "CURSOR_API_KEY");
  } catch {
    return undefined;
  }
  if (fromEnv !== undefined && fromEnv.trim() !== "") {
    return fromEnv.trim();
  }
  const filePath = path.join(
    globalCredentialRoot(),
    "agent",
    CURSOR_API_KEY_FILE_NAME,
  );
  if (!existsSync(filePath)) {
    return undefined;
  }
  try {
    const raw = readFileSync(filePath, "utf8").replace(/\r?\n$/, "").trim();
    return raw.length > 0 ? raw : undefined;
  } catch {
    return undefined;
  }
}

export function getCursorHostStatus(
  env: NodeJS.ProcessEnv = process.env,
): {
  cursorSdkReady: boolean;
  cursorApiKeyConfigured: boolean;
} {
  const key = readCursorApiKey(env);
  return {
    cursorSdkReady: resolveCursorExtensionPath() !== undefined,
    cursorApiKeyConfigured: key !== undefined,
  };
}

registerProviderSupport(cursorProviderSupport);

function resolveFromPiSettings(): string | undefined {
  const agentDir = piAgentDir();
  const settingsPath = path.join(agentDir, "settings.json");
  if (!existsSync(settingsPath)) {
    return undefined;
  }

  let settings: { packages?: unknown };
  try {
    settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      packages?: unknown;
    };
  } catch {
    return undefined;
  }

  if (!Array.isArray(settings.packages)) {
    return undefined;
  }

  for (const entry of settings.packages) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const pkg = entry as { source?: unknown; extensions?: unknown };
    if (typeof pkg.source !== "string") {
      continue;
    }
    if (!pkg.source.includes("pi-cursor-sdk")) {
      continue;
    }

    const packageRoot = path.resolve(agentDir, pkg.source);
    if (Array.isArray(pkg.extensions)) {
      for (const ext of pkg.extensions) {
        if (typeof ext !== "string") {
          continue;
        }
        const rel = ext.replace(/^\+/, "");
        const full = path.resolve(packageRoot, rel);
        if (existsSync(full)) {
          return full;
        }
      }
    }

    const declared = cursorExtensionEntryInPackage(packageRoot);
    if (declared) {
      return declared;
    }
  }

  return undefined;
}
