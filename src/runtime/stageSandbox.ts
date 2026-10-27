import {
  assertStageReadOnlyDirExists,
  resolveSandboxContainerOptions,
  stageReadOnlyDir,
  startSandboxContainer,
  stopSandboxContainer,
} from "./sandboxContainer.js";
import {
  buildSandboxDesk,
  populateSandboxDesk,
  syncSandboxDesk,
  type SandboxDesk,
} from "./sandboxDesk.js";
import { withContainerName, type StageRoots } from "./stageRoots.js";

export type StageSandbox = {
  roots: StageRoots;
  beforeVerify?: () => Promise<void>;
  close: () => Promise<void>;
  failure?: string;
};

export async function openStageSandbox(input: {
  env: NodeJS.ProcessEnv;
  roots: StageRoots;
  runId: string;
  stageId: string;
  attempt: number;
  attemptDir: string;
  checkoutRoot?: string;
}): Promise<StageSandbox> {
  const options = resolveSandboxContainerOptions(input.env);
  if (!options) {
    return { roots: input.roots, close: async () => {} };
  }

  let readOnlyDir: string | undefined;
  try {
    readOnlyDir = stageReadOnlyDir(input.env);
    if (readOnlyDir !== undefined) await assertStageReadOnlyDirExists(readOnlyDir);
  } catch (err) {
    return {
      roots: input.roots,
      close: async () => {},
      failure: err instanceof Error ? err.message : String(err),
    };
  }

  const started = await startSandboxContainer({
    image: options.image,
    dockerBin: options.dockerBin,
    runId: input.runId,
    stageId: input.stageId,
    attempt: input.attempt,
    ...(readOnlyDir !== undefined ? { readOnlyDir } : {}),
  });
  const roots = withContainerName(
    readOnlyDir !== undefined ? { ...input.roots, readonlyDir: readOnlyDir } : input.roots,
    started.containerName,
    options.dockerBin,
  );
  const checkout = input.checkoutRoot?.trim();
  const desk = buildSandboxDesk({
    attemptDir: input.attemptDir,
    ...(checkout ? { checkoutRoot: checkout } : {}),
  });

  const session: StageSandbox = {
    roots,
    close: () =>
      stopSandboxContainer({
        containerName: started.containerName,
        dockerBin: options.dockerBin,
      }).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          `[stageWorker] failed to stop sandbox container ${started.containerName}: ${message}\n`,
        );
      }),
  };

  try {
    await populateSandboxDesk({
      containerName: started.containerName,
      dockerBin: options.dockerBin,
      desk,
    });
  } catch (err) {
    session.failure = err instanceof Error ? err.message : String(err);
    return session;
  }

  session.beforeVerify = syncOnce(started.containerName, options.dockerBin, desk);
  return session;
}

function syncOnce(
  containerName: string,
  dockerBin: string | undefined,
  desk: SandboxDesk,
): () => Promise<void> {
  let synced = false;
  return async () => {
    if (synced) return;
    synced = true;
    await syncSandboxDesk({ containerName, dockerBin, desk });
  };
}
