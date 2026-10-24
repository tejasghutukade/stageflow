import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
  ENGINE_DIR_NAME,
  ENGINE_INSTALL_COMMAND,
  ENGINE_MARKER_FILE,
  PINNED_PROMPTFOO_VERSION,
} from "./pinned.js";

export type EngineMarker = {
  version: string;
  node: string;
  installedAt: string;
  integrity: string | null;
};

export type LocateResult =
  | { installed: true; version: string; binPath: string; dir: string }
  | { installed: false; reason: string };

export function engineRoot(home: string): string {
  return path.join(home, ENGINE_DIR_NAME);
}

export function engineDir(home: string, version: string = PINNED_PROMPTFOO_VERSION): string {
  return path.join(engineRoot(home), version);
}

export function engineBinPath(dir: string): string {
  const name = process.platform === "win32" ? "promptfoo.cmd" : "promptfoo";
  return path.join(dir, "node_modules", ".bin", name);
}

function readJson(file: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function otherInstalledVersions(home: string): string[] {
  const root = engineRoot(home);
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter(
      (name) =>
        name !== PINNED_PROMPTFOO_VERSION &&
        existsSync(path.join(root, name, ENGINE_MARKER_FILE)),
    )
    .sort();
}

function missing(detail: string): LocateResult {
  return {
    installed: false,
    reason: `${detail}. Run \`${ENGINE_INSTALL_COMMAND}\`.`,
  };
}

export function locatePromptfoo(opts: { home: string }): LocateResult {
  const dir = engineDir(opts.home);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    const others = otherInstalledVersions(opts.home);
    if (others.length > 0) {
      return missing(
        `promptfoo ${others.join(", ")} is installed but Stageflow needs ${PINNED_PROMPTFOO_VERSION}`,
      );
    }
    return missing(`promptfoo ${PINNED_PROMPTFOO_VERSION} is not installed`);
  }
  const marker = readJson(path.join(dir, ENGINE_MARKER_FILE));
  if (!marker) {
    return missing(`promptfoo ${PINNED_PROMPTFOO_VERSION} install is incomplete (no marker)`);
  }
  if (marker.version !== PINNED_PROMPTFOO_VERSION) {
    return missing(
      `promptfoo ${String(marker.version)} is installed but Stageflow needs ${PINNED_PROMPTFOO_VERSION}`,
    );
  }
  const pkg = readJson(path.join(dir, "node_modules", "promptfoo", "package.json"));
  if (!pkg) {
    return missing(`promptfoo ${PINNED_PROMPTFOO_VERSION} install is broken (package missing)`);
  }
  if (pkg.version !== PINNED_PROMPTFOO_VERSION) {
    return missing(
      `promptfoo ${String(pkg.version)} is installed but Stageflow needs ${PINNED_PROMPTFOO_VERSION}`,
    );
  }
  const binPath = engineBinPath(dir);
  if (!existsSync(binPath)) {
    return missing(`promptfoo ${PINNED_PROMPTFOO_VERSION} install is broken (no binary)`);
  }
  return { installed: true, version: PINNED_PROMPTFOO_VERSION, binPath, dir };
}
