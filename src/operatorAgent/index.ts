export type {
  OperatorAgentContextAdapter,
  OperatorAgentHost,
  OperatorAgentProfile,
  OperatorAgentProposal,
  OperatorAgentSession,
  OperatorAgentSessionEvent,
  OperatorAgentTool,
  OperatorAgentToolContext,
  OperatorAgentToolResult,
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
} from "./fakeHost.js";
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
  buildStageAddProposal,
  createWorkshopAuthorProfile,
  proposeStageFromUserMessage,
  WORKSHOP_AUTHOR_PLAYBOOK,
  WORKSHOP_AUTHOR_PROFILE_ID,
  workshopAuthorTools,
} from "./profiles/workshopAuthor.js";
