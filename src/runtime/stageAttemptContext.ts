import {
  attemptAgentDir,
  attemptSessionPath,
} from "../runstore/workspaceLayout.js";

export type StageAttemptContext = {
  readonly attempt: number;
  eventOptions(): { attempt: number } | undefined;
  sessionPath(workspaceDir: string, stageId: string): string;
  agentDirPath(workspaceDir: string, stageId: string): string;
};

function createAttemptContext(attempt: number): StageAttemptContext {
  return {
    attempt,
    eventOptions() {
      if (attempt <= 1) return undefined;
      return { attempt };
    },
    sessionPath(workspaceDir, stageId) {
      return attemptSessionPath(workspaceDir, stageId, attempt);
    },
    agentDirPath(workspaceDir, stageId) {
      return attemptAgentDir(workspaceDir, stageId, attempt);
    },
  };
}

export function attemptContext(attempt: number): StageAttemptContext {
  return createAttemptContext(attempt);
}

export function noAttemptContext(): StageAttemptContext {
  return createAttemptContext(1);
}

export function resumeSessionFilePath(
  workspaceDir: string,
  stageId: string,
  attempt: number,
): string {
  return attemptContext(attempt).sessionPath(workspaceDir, stageId);
}
