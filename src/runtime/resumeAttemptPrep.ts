import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { attemptWorkspaceDir } from "../runstore/workspaceLayout.js";
import {
  registerNamedSecrets,
  REDACTION_SECRETS_FILENAME,
} from "../logging/namedSecrets.js";
import { logger as rootLogger } from "../logging/logger.js";
import type { ResolvedStageGrants } from "./stageEnvironment.js";
import type { StageSecretDecl } from "./stageSecretDecl.js";
import {
  cleanupCredentialsDir,
  loadSecretRegistry,
  resolveStageSecrets,
  SecretUnavailableError,
  type SecretRegistry,
} from "./stageSecrets.js";

export type PrepareResumeAttemptInput = {
  workspaceDir: string;
  stageId: string;
  attempt: number;
  secrets: readonly StageSecretDecl[] | undefined;
  hostEnv: NodeJS.ProcessEnv;
  home?: string;
  registry?: SecretRegistry;
  logContext?: { run_id: string; stage_id: string };
};

export type PrepareResumeAttemptResult = {
  attemptDir: string;
  attemptHome: string;
  grants: ResolvedStageGrants;
  cleanup: () => void;
};

export function resumeAttemptCleanup(attemptDir: string): () => void {
  return () => {
    try {
      cleanupCredentialsDir(attemptDir);
    } catch {
      // best-effort Host cleanup
    }
  };
}

export function secretUnavailableMessage(err: unknown): string {
  if (err instanceof SecretUnavailableError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

export async function prepareResumeAttemptHome(
  input: PrepareResumeAttemptInput,
): Promise<PrepareResumeAttemptResult> {
  const attemptDir = attemptWorkspaceDir(
    input.workspaceDir,
    input.stageId,
    input.attempt,
  );
  await mkdir(attemptDir, { recursive: true });
  const attemptHome = path.join(attemptDir, "home");
  await mkdir(attemptHome, { recursive: true });
  const cleanup = resumeAttemptCleanup(attemptDir);

  try {
    const resolved = resolveStageSecrets({
      decls: input.secrets,
      registry:
        input.registry ?? loadSecretRegistry(input.hostEnv, input.home),
      hostEnv: input.hostEnv,
      attemptDir,
      ...(input.home !== undefined ? { home: input.home } : {}),
    });
    registerNamedSecrets(resolved.knownValues);
    await writeFile(
      path.join(attemptDir, REDACTION_SECRETS_FILENAME),
      `${JSON.stringify(resolved.knownValues)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    for (const warning of resolved.warnings) {
      rootLogger.warn("stage.secrets", warning, input.logContext);
    }
    await writeFile(
      path.join(attemptDir, "declared-secrets.json"),
      `${JSON.stringify({ names: resolved.grants.declaredSecretNames }, null, 2)}\n`,
      "utf8",
    );
    return {
      attemptDir,
      attemptHome,
      grants: resolved.grants,
      cleanup,
    };
  } catch (err) {
    cleanup();
    throw err;
  }
}
