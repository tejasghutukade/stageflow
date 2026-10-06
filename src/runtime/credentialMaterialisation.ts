import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { ensureGlobalHome, globalStageflowHome } from "../project/globalHome.js";

export type MaterialiseCopyResult = {
  destPath: string;
  mode: number;
};

export class CredentialMaterialisationError extends Error {
  readonly code:
    | "symlink_rejected"
    | "escape_rejected"
    | "source_missing"
    | "not_a_file";

  constructor(
    message: string,
    code: CredentialMaterialisationError["code"],
  ) {
    super(message);
    this.name = "CredentialMaterialisationError";
    this.code = code;
  }
}

export function attemptCredentialsDir(
  attemptDir: string,
  secretName: string,
): string {
  return path.join(attemptDir, "credentials", secretName);
}

/** Copy a Host source file into attempt credentials with mode 0400. */
export function materialiseCredentialFile(options: {
  sourcePath: string;
  destDir: string;
  destBasename?: string;
  allowedRoot?: string;
}): MaterialiseCopyResult {
  const sourcePath = path.resolve(options.sourcePath);
  let stat;
  try {
    stat = lstatSync(sourcePath);
  } catch {
    throw new CredentialMaterialisationError(
      `credential source missing: ${sourcePath}`,
      "source_missing",
    );
  }
  if (stat.isSymbolicLink()) {
    throw new CredentialMaterialisationError(
      `credential source must not be a symlink: ${sourcePath}`,
      "symlink_rejected",
    );
  }
  if (!stat.isFile()) {
    throw new CredentialMaterialisationError(
      `credential source must be a regular file: ${sourcePath}`,
      "not_a_file",
    );
  }
  const realSource = realpathSync(sourcePath);
  if (options.allowedRoot !== undefined) {
    let root = path.resolve(options.allowedRoot);
    try {
      root = realpathSync(root);
    } catch {
      // allowed root may not exist yet; keep resolved path
    }
    if (realSource !== root && !realSource.startsWith(root + path.sep)) {
      throw new CredentialMaterialisationError(
        `credential source escapes allowed root: ${sourcePath}`,
        "escape_rejected",
      );
    }
  }
  mkdirSync(options.destDir, { recursive: true, mode: 0o700 });
  const destPath = path.join(
    options.destDir,
    options.destBasename ?? path.basename(realSource),
  );
  copyFileSync(realSource, destPath);
  try {
    chmodSync(destPath, 0o400);
  } catch {
    // best-effort on non-POSIX
  }
  return { destPath, mode: 0o400 };
}

export function materialiseSecretBytes(options: {
  contents: string | Buffer;
  destDir: string;
  destBasename: string;
}): MaterialiseCopyResult {
  mkdirSync(options.destDir, { recursive: true, mode: 0o700 });
  const destPath = path.join(options.destDir, options.destBasename);
  writeFileSync(destPath, options.contents, { mode: 0o400 });
  try {
    chmodSync(destPath, 0o400);
  } catch {
    // best-effort
  }
  return { destPath, mode: 0o400 };
}

export function cleanupCredentialsDir(attemptDir: string): void {
  const root = path.join(attemptDir, "credentials");
  if (!existsSync(root)) return;
  rmSync(root, { recursive: true, force: true });
}

const STAGE_ASKPASS_BASENAME = "git-askpass-stage";

const STAGE_ASKPASS_SCRIPT = `#!/bin/sh
prompt=\${1-}
case "\$prompt" in
  *Username*|*username*)
    printf '%s\\n' 'x-access-token'
    ;;
  *)
    token=
    if [ -n "\${STAGEFLOW_GIT_ASKPASS_TOKEN_FILE-}" ] && [ -f "\$STAGEFLOW_GIT_ASKPASS_TOKEN_FILE" ]; then
      token=\$(cat "\$STAGEFLOW_GIT_ASKPASS_TOKEN_FILE")
    fi
    printf '%s\\n' "\$token"
    ;;
esac
`;

export function stageAskpassHelperPath(
  home: string = globalStageflowHome(),
): string {
  return path.join(home, STAGE_ASKPASS_BASENAME);
}

export function ensureStageAskpassHelper(home?: string): string {
  const resolvedHome = home ?? ensureGlobalHome();
  mkdirSync(resolvedHome, { recursive: true });
  const askpass = stageAskpassHelperPath(resolvedHome);
  writeFileSync(askpass, STAGE_ASKPASS_SCRIPT, { encoding: "utf8", mode: 0o700 });
  try {
    chmodSync(askpass, 0o700);
  } catch {
    // best-effort
  }
  return askpass;
}

export function readFileCredentialRegistry(
  home: string = globalStageflowHome(),
): Record<string, { source: string; pointerVar: string }> {
  const registryPath = path.join(home, "secrets", "file-credentials.json");
  if (!existsSync(registryPath)) return {};
  try {
    const raw = JSON.parse(readFileSync(registryPath, "utf8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: Record<string, { source: string; pointerVar: string }> = {};
    for (const [name, entry] of Object.entries(
      raw as Record<string, unknown>,
    )) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const e = entry as Record<string, unknown>;
      if (typeof e.source !== "string" || typeof e.pointerVar !== "string") {
        continue;
      }
      out[name] = { source: e.source, pointerVar: e.pointerVar };
    }
    return out;
  } catch {
    return {};
  }
}
