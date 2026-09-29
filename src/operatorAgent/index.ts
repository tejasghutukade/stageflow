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
