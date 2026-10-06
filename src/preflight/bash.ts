import { accessSync, constants } from "node:fs";
import path from "node:path";

export type BashPreflightErrorCode = "bash_not_found";

export class BashPreflightError extends Error {
  readonly code: BashPreflightErrorCode;

  constructor(message: string, code: BashPreflightErrorCode = "bash_not_found") {
    super(message);
    this.name = "BashPreflightError";
    this.code = code;
  }
}

function isExecutable(filePath: string): boolean {
  try {
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Resolve `bash` on PATH (never hardcode /bin/bash). */
export function resolveBashPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const pathValue = env.PATH ?? "";
  const parts = pathValue.split(path.delimiter).filter((p) => p.length > 0);
  for (const dir of parts) {
    const candidate = path.join(dir, "bash");
    if (isExecutable(candidate)) {
      return candidate;
    }
  }
  throw new BashPreflightError(
    'bash was not found on PATH; Stageflow verify requires bash (install bash or fix PATH)',
    "bash_not_found",
  );
}

export function assertBashAvailable(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return resolveBashPath(env);
}
