import type { BootProviderResult } from "../agent/bootProviderConfig.js";
import type { ProviderAuthContext } from "../agent/providerAuth.js";
import type { AgentChatController } from "../agents/chatTurn.js";
import type { ConversationBackend } from "../agents/sessions.js";
import type { AgentService } from "../agents/service.js";
import type { RunStore } from "../runstore/port.js";
import type { RunChangeBus } from "../runtime/runChangeBus.js";
import type { EngineStatus } from "../evals/engine/promptfoo/status.js";
import type { EvalRunManager } from "../evals/manager.js";
import type { TriageDeps } from "../evals/triage/service.js";
import type { ChannelService } from "../channels/service.js";
import type { IssueFetch } from "../config/importTask.js";
import type { MemoryHost } from "../memory/host.js";
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
  /** Failure sorting seams: key lookup, fetch and base URL for the Jev classifier, or a judge model (tests). */
  triage?: Omit<TriageDeps, "store">;
  /** Host connections. Absent when the process has no channel service. */
  channels?: ChannelService;
  /** Host memories under $STAGEFLOW_HOME. Absent when memory is not configured. */
  memories?: MemoryHost;
  /** GitHub issue fetch for `import_task_file`. Tests inject this. Production uses the default client. */
  issueFetch?: IssueFetch;
};

export type McpHttpDeps = McpToolDeps & {
  runChangeBus: RunChangeBus;
};
