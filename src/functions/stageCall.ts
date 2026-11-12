import { attemptArtifactsDir } from "../runstore/workspaceLayout.js";

export type StageFunctionCallPlace = {
  roots: { artifacts: string; workspace: string };
  containerName?: string;
  containerDockerBin?: string;
};

export function stageFunctionCallPlace(input: {
  runWorkspaceDir: string;
  stageId: string;
  attempt?: number;
  checkoutRoot?: string;
  cwd: string;
  containerName?: string;
  containerDockerBin?: string;
  synced?: boolean;
}): StageFunctionCallPlace {
  const hostWorkspace = input.checkoutRoot ?? input.cwd;
  const workspace =
    input.containerName !== undefined && input.synced !== true ? "/workspace/checkout" : hostWorkspace;
  const place: StageFunctionCallPlace = {
    roots: {
      artifacts: attemptArtifactsDir(input.runWorkspaceDir, input.stageId, input.attempt ?? 1),
      workspace,
    },
  };
  if (input.containerName !== undefined) place.containerName = input.containerName;
  if (input.containerDockerBin !== undefined) place.containerDockerBin = input.containerDockerBin;
  return place;
}
