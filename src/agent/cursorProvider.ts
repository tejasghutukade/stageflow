/**
 * Cursor-only StageProviderSupport for pi-cursor-sdk.
 *
 * Loaded only when stage.model is `cursor/...`. Other providers never hit this
 * module's prepare()/env sealing path.
 */
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
 * 2. Path package from ~/.pi/agent/settings.json (same source interactive pi uses)
 * 3. npm install under ~/.pi/agent/npm/node_modules/pi-cursor-sdk
 * 4. Sibling checkout at ../pi-cursor-sdk relative to this repo
 */
export function resolveCursorExtensionPath(): string | undefined {
  const fromEnv = process.env.STAGEFLOW_CURSOR_EXTENSION?.trim();
  if (fromEnv && existsSync(fromEnv)) {
    return path.resolve(fromEnv);
  }

  const fromSettings = resolveFromPiSettings();
  if (fromSettings) {
    return fromSettings;
  }

  const npmEntry = path.join(
    os.homedir(),
    ".pi",
    "agent",
    "npm",
    "node_modules",
    "pi-cursor-sdk",
    "src",
    "index.ts",
  );
  if (existsSync(npmEntry)) {
    return npmEntry;
  }

  const here = path.dirname(fileURLToPath(import.meta.url));
  const sibling = path.resolve(here, "../../../pi-cursor-sdk/src/index.ts");
  if (existsSync(sibling)) {
    return sibling;
  }

  return undefined;
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
    "Install with `pi install npm:pi-cursor-sdk`, or set STAGEFLOW_CURSOR_EXTENSION",
    "to the absolute path of pi-cursor-sdk/src/index.ts.",
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

registerProviderSupport(cursorProviderSupport);

function resolveFromPiSettings(): string | undefined {
  const settingsPath = path.join(os.homedir(), ".pi", "agent", "settings.json");
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

  const agentDir = path.join(os.homedir(), ".pi", "agent");
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

    const declared = path.join(packageRoot, "src", "index.ts");
    if (existsSync(declared)) {
      return declared;
    }
  }

  return undefined;
}
