import {
  ensureWorkspaceCatalog,
  resetWorkspaceProvisionForTests,
} from "../../src/project/workspaceCatalog.js";
import { resetGlobalStageflowHomeForTests } from "../../src/project/globalHome.js";

export function bindStageflowHomeForTests(home: string): void {
  process.env.STAGEFLOW_HOME = home;
  resetGlobalStageflowHomeForTests();
  resetWorkspaceProvisionForTests();
  ensureWorkspaceCatalog(home);
}
