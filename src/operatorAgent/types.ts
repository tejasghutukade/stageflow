import type { DraftPackage } from "../config/draftPackage.js";
import type { ValidationResult } from "../config/validateCatalog.js";
import type {
  AcceptProposalResult,
  ProposalArtifactDiff,
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
  emitProposal(proposal: OperatorAgentProposal): void;
  getAutoApply(): boolean;
};

export type OperatorAgentProposal = {
  id: string;
  summary: string;
  /** Full proposed context after Accept (Workshop: DraftPackage). */
  nextContext: unknown;
  /** Context snapshot when the proposal was created. */
  baseContext?: unknown;
  /** Fingerprint of the draft at propose time — used for stale detection. */
  baseFingerprint?: string;
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
  | { type: "proposal"; proposal: OperatorAgentProposal; autoApplied?: boolean }
  | { type: "tool_result"; name: string; result: OperatorAgentToolResult }
  | { type: "validation"; result: ValidationResult }
  | { type: "error"; message: string };

export type OperatorAgentSession = {
  readonly profileId: string;
  readonly profileTitle: string;
  getContext(): unknown;
  setContext(next: unknown): void;
  getPendingProposal(): OperatorAgentProposal | null;
  getAutoApply(): boolean;
  setAutoApply(enabled: boolean): void;
  send(message: string): Promise<OperatorAgentSessionEvent[]>;
  acceptProposal(proposalId?: string): AcceptProposalResult;
  rejectProposal(proposalId?: string): boolean;
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
};

export type { AcceptProposalResult, ProposalArtifactDiff };
