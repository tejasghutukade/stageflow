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
  withDraft,
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
  buildStageAddProposal,
  buildTaskAddProposal,
  createWorkshopAuthorProfile,
  createWorkshopAuthorTools,
  isTaskProposalIntent,
  proposeStageFromUserMessage,
  proposeTaskFromUserMessage,
  WORKSHOP_AUTHOR_PLAYBOOK,
  WORKSHOP_AUTHOR_PROFILE_ID,
  workshopAuthorTools,
  type WorkshopAuthorProfileOptions,
} from "./profiles/workshopAuthor.js";
