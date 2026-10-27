export type {
  AcceptProposalResult,
  OperatorAgentContextAdapter,
  OperatorAgentHost,
  OperatorAgentProfile,
  OperatorAgentProposal,
  OperatorAgentSession,
  OperatorAgentSessionEvent,
  OperatorAgentTool,
  OperatorAgentToolContext,
  OperatorAgentToolResult,
  ProposalArtifactDiff,
  UndoMutationResult,
  WorkshopDraftContext,
  WorkshopToolActivityUpdate,
} from "./types.js";
export {
  createOperatorAgentHost,
  invokeProfileTool,
  type OperatorAgentModel,
  type OperatorAgentModelTurn,
} from "./host.js";
export {
  createFakeOperatorAgentModel,
  createWorkshopOperatorHost,
  type FakeOperatorTurn,
  type WorkshopOperatorHostOptions,
} from "./fakeHost.js";
export {
  AGENT_PORT_BACKENDS,
  createPiAgentPort,
  resolveAgentPort,
  type AgentPortBackendId,
  type AgentPort,
  type AgentPortOptions,
} from "./agentPort.js";
export {
  createLiveWorkshopOperatorHost,
  createPiOperatorAgentModel,
  type LiveWorkshopOperatorHostOptions,
  type PiOperatorAgentModel,
  type PiOperatorAgentModelOptions,
  type PiOperatorOpenSessionInput,
  type PiOperatorSessionHandle,
  type WorkshopTranscriptSeedMessage,
} from "./piModel.js";
export {
  createFailingDocsRetriever,
  createFilesystemDocsRetriever,
  createStubDocsRetriever,
  resolveWorkshopCatalogRoot,
  type DocsRetrievalHit,
  type DocsRetrievalResult,
  type DocsRetriever,
} from "./docsRetrieval.js";
export {
  agentAuthorContextAdapter,
  emptyAgentAuthorDraft,
  isAgentAuthorContext,
  readAgentAuthorDraft,
  AGENT_AUTHOR_GREETING,
  type AgentAuthorContext,
  type AgentAuthorDraft,
} from "./agentAuthorContext.js";
export {
  AGENT_AUTHOR_PROFILE_ID,
  AGENT_AUTHOR_TOOL_NAMES,
  createAgentAuthorContext,
  createAgentAuthorProfile,
} from "./profiles/agentAuthor.js";
export {
  STAGEFLOW_GUIDE_GREETING,
  STAGEFLOW_GUIDE_PLAYBOOK,
  STAGEFLOW_GUIDE_PROFILE_ID,
  STAGEFLOW_GUIDE_TOOL_NAMES,
  createStageflowGuideProfile,
} from "./profiles/stageflowGuide.js";
export { AGENT_AUTHOR_PLAYBOOK } from "./profiles/agentAuthorPlaybook.js";
export { operatorContextFingerprint } from "./proposals.js";
export {
  createWorkshopDraftContext,
  draftTrackStages,
  emptyDraftPackage,
  isWorkshopDraftContext,
  readDraftFromContext,
  withDestination,
  withDraft,
  withProjectRoot,
  workshopDraftContextAdapter,
  WORKSHOP_AUTHOR_GREETING,
} from "./draftContext.js";
export {
  affectedStageIds,
  diffDraftPackages,
  draftFingerprint,
  enrichProposal,
  isMutationConflict,
  STALE_PROPOSAL_NOTICE,
  UNDO_MUTATION_CONFLICT_NOTICE,
} from "./proposals.js";
export {
  assertWorkshopAuthorToolsExcludeDiskShell,
  buildStageAddProposal,
  buildTaskAddProposal,
  createWorkshopAuthorProfile,
  createWorkshopAuthorTools,
  isTaskProposalIntent,
  proposeStageFromUserMessage,
  proposeTaskFromUserMessage,
  WORKSHOP_AUTHOR_PLAYBOOK,
  WORKSHOP_AUTHOR_PROFILE_ID,
  WORKSHOP_AUTHOR_TOOL_NAMES,
  WORKSHOP_FORBIDDEN_AGENT_TOOLS,
  workshopAuthorTools,
  type WorkshopAuthorProfileOptions,
} from "./profiles/workshopAuthor.js";
export {
  buildCreatePipelineDraft,
  buildCreateStageDraft,
  buildCreateTaskDraft,
  buildEditPipelineDraft,
  buildEditStageDraft,
  buildEditTaskDraft,
  createSaveTool,
  createWorkshopAuthorMutatingTools,
  WORKSHOP_AUTHOR_MUTATING_TOOLS,
} from "./profiles/workshopAuthorTools.js";
