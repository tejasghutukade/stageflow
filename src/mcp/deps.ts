import type { BootProviderResult } from "../agent/bootProviderConfig.js";
import type { ProviderAuthContext } from "../agent/providerAuth.js";
import type { AgentChatController } from "../agents/chatTurn.js";
import type { ConversationBackend } from "../agents/sessions.js";
import type { AgentService } from "../agents/service.js";
import type { RunStore } from "../runstore/port.js";
import type { RunChangeBus } from "../runtime/runChangeBus.js";
import type { EngineStatus } from "../evals/engine/promptfoo/status.js";
import type { EvalRunManager } from "../evals/manager.js";
import type { RunManager } from "../runtime/runManager.js";

export type McpToolDeps = {
  manager: RunManager;
  store: RunStore;
  cwd: string;
  agentDir?: string;
  providerAuthContext?: ProviderAuthContext;
  projectRoot?: string;
  providerBoot?: BootProviderResult;
  agentService?: AgentService;
  agentChat?: AgentChatController;
  agentConversationBackend?: ConversationBackend;
  evalRunManager?: EvalRunManager;
  evalEngineStatus?: () => EngineStatus;
};

export type McpHttpDeps = McpToolDeps & {
  runChangeBus: RunChangeBus;
};
