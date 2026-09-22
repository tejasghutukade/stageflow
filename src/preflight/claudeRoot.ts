export type ClaudeRootErrorCode = "claude_as_root";

export class ClaudeRootError extends Error {
  readonly code: ClaudeRootErrorCode = "claude_as_root";
  readonly euid: number;

  constructor(euid: number) {
    super(
      `Claude backend cannot run as root (euid=${euid}). Use a non-root USER or docker --user.`,
    );
    this.name = "ClaudeRootError";
    this.euid = euid;
  }
}

export function isEffectiveRoot(
  geteuid: (() => number) | undefined = process.geteuid,
): boolean {
  if (typeof geteuid !== "function") return false;
  return geteuid() === 0;
}

export function assertClaudeNotRoot(options: {
  backendId: string | undefined;
  geteuid?: (() => number) | undefined;
}): void {
  if (options.backendId !== "claude") return;
  const geteuid = options.geteuid ?? process.geteuid;
  if (isEffectiveRoot(geteuid)) {
    const euid = typeof geteuid === "function" ? geteuid() : 0;
    throw new ClaudeRootError(euid);
  }
}
