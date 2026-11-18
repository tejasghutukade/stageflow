import { ensureWorkspaceCatalog } from "../project/workspaceCatalog.js";
import { installStartersWhenConnected } from "../project/starters.js";
import { globalStageflowHome } from "../project/globalHome.js";

export type ProvisionStartersResult = {
  installed: boolean;
  files: string[];
  workspacePath: string;
};

export async function provisionStartersFromCli(cwd: string): Promise<ProvisionStartersResult> {
  const home = globalStageflowHome();
  ensureWorkspaceCatalog(home);
  const workspacePath = ensureWorkspaceCatalog(home).path;
  const result = await installStartersWhenConnected({
    cwd,
    workspacePath,
    refresh: true,
  });
  return { ...result, workspacePath };
}