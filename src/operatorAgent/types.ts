import type { DraftPackage } from "../config/draftPackage.js";
import type { ValidationResult } from "../config/validateCatalog.js";
import type {
  AcceptProposalResult,
  ProposalArtifactDiff,
  UndoMutationResult,
} from "./proposals.js";

export type OperatorAgentToolResult = {
  ok: boolean;
  content: unknown;
  error?: string;
};

export type OperatorAgentToolHandler = (
  args: Record<string, unknown>,
  ctx: OperatorAgentToolContext,
) => Promise<OperatorAgentToolResult> | OperatorAgentToolResult;

export type OperatorAgentTool = {
  name: string;
  description: string;
  handler: OperatorAgentToolHandler;
};

export type OperatorAgentToolContext = {
  getContext(): unknown;
  setContext(next: unknown): void;
  /** Apply mutation immediately and record an undo receipt. */
  emitProposal(proposal: OperatorAgentProposal): void;
};

export type OperatorAgentProposal = {
  /** Mutation id (Accept confirms; Reject / undoMutation soft-undos). */
  id: string;
  summary: string;
  /** Context after the mutation (already applied to the session). */
  nextContext: unknown;
  /** Context snapshot before the mutation (restore target for undo). */
  baseContext?: unknown;
  /** Fingerprint of the draft before apply. */
  baseFingerprint?: string;
  /** Fingerprint of the draft immediately after apply — undo requires a match. */
  appliedFingerprint?: string;
  artifacts?: ProposalArtifactDiff[];
  affectedStageIds?: string[];
};

export type OperatorAgentContextAdapter = {
  serialize(context: unknown): unknown;
  applyProposal(context: unknown, proposal: OperatorAgentProposal): unknown;
};

export type OperatorAgentProfile = {
  id: string;
  title: string;
  playbook: string;
  tools: OperatorAgentTool[];
  contextAdapter: OperatorAgentContextAdapter;
  greeting?: string;
};

export type OperatorAgentSessionEvent =
  | { type: "message"; role: "assistant" | "user" | "system"; text: string }
  | { type: "proposal"; proposal: OperatorAgentProposal }
  | { type: "tool_result"; name: string; result: OperatorAgentToolResult }
  | { type: "validation"; result: ValidationResult }
  | { type: "error"; message: string };

export type WorkshopToolActivityUpdate = {
  id: string;
  name: string;
  status: "running" | "complete" | "error";
  target?: string;
  errorMessage?: string;
  draft?: DraftPackage;
  /** Build the turn is editing. Absent when the chat is unlinked. */
  buildId?: string;
};

export type OperatorAgentSession = {
  readonly profileId: string;
  readonly profileTitle: string;
  getContext(): unknown;
  setContext(next: unknown): void;
  /** Latest undoable mutation (Accept-card payload), or null. */
  getPendingProposal(): OperatorAgentProposal | null;
  getMutation(mutationId: string): OperatorAgentProposal | null;
  /**
   * Seed backend from prior transcript after process restart (KTD7).
   * No-op for fake / models without prepareRestart.
   */
  prepareRestart?(
    transcript: readonly { role: string; text: string }[],
  ): Promise<void>;
  send(
    message: string,
    options?: {
      onDelta?: (text: string) => void;
      onActivity?: (update: WorkshopToolActivityUpdate) => void;
      modelId?: string;
    },
  ): Promise<OperatorAgentSessionEvent[]>;
  /** Interrupt the in-flight prompt. Resolves when the backend is idle. */
  abort(): Promise<void>;
  /** Confirm mutation (soft UX); draft already applied — does not re-apply. */
  acceptProposal(proposalId?: string): AcceptProposalResult;
  /** Soft-undo the mutation when the applied fingerprint still matches. */
  rejectProposal(proposalId?: string): UndoMutationResult;
  undoMutation(mutationId?: string): UndoMutationResult;
  close(): void;
};

export type OperatorAgentHost = {
  registerProfile(profile: OperatorAgentProfile): void;
  getProfile(id: string): OperatorAgentProfile | undefined;
  listProfiles(): OperatorAgentProfile[];
  openSession(input: {
    profileId: string;
    context: unknown;
  }): OperatorAgentSession;
};

export type WorkshopDraftContext = {
  draft: DraftPackage;
  destination?: {
    directory: string;
    pipelineFilename?: string;
  };
  /** Catalog write root for the save tool (usually the operator project). */
  projectRoot?: string;
  /** Workshop chat session that owns this host context. */
  chatSessionId?: string;
  /** Build this turn is editing. Absent when that chat is unlinked. */
  buildId?: string;
};

export type { AcceptProposalResult, ProposalArtifactDiff, UndoMutationResult };
