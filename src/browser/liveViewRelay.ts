import type { BrowserEnv } from "./browserHost.js";

export type LiveViewMessage = {
  type: "frame" | "status" | "tabs" | "url" | "retarget" | "closed" | "dialog" | "dialog_closed";
  data: unknown;
};

export type LiveViewInputEvent = Record<string, unknown> & { type: string };

export type LiveViewSubscriber = (message: LiveViewMessage) => void;

export type LiveViewInputRejection =
  | "closed"
  | "not_array"
  | "batch_too_large"
  | "rate_limited"
  | "invalid_event"
  | "upstream_unavailable";

/** A rejected batch forwards nothing. */
export type LiveViewInputResult =
  | { ok: true; accepted: number }
  | { ok: false; reason: LiveViewInputRejection };

export type LiveViewDialogKind = "alert" | "confirm" | "prompt" | "beforeunload";

/** Untrusted page text: plain text only, never HTML, never logged. */
export type LiveViewDialog = {
  id: string;
  kind: LiveViewDialogKind;
  message: string;
  defaultPrompt: string;
  targetId: string;
  /** False for alert and beforeunload: agent-browser accepts them within milliseconds. */
  answerable: boolean;
};

export type LiveViewDialogCloseResult = "accepted" | "dismissed" | "timeout" | "closed_by_page";

export type LiveViewDialogAnswer = { id: string; accept: boolean; promptText?: string };

export type LiveViewDialogRejection = "no_dialog" | "not_answerable" | "invalid" | "closed";

export type LiveViewDialogResult = { ok: true } | { ok: false; reason: LiveViewDialogRejection };

export type LiveViewReopenRejection =
  | "closed"
  | "no_tab"
  | "upstream_unavailable"
  | "rate_limited"
  | "failed";

export type LiveViewReopenResult = { ok: true } | { ok: false; reason: LiveViewReopenRejection };

export type LiveViewSessionRequest = {
  runId: string;
  stageId: string;
  /** The stage's persisted browser env; the relay never changes it. */
  env: BrowserEnv;
  /** The run's shared browser anchor env, when the stage has a profile. */
  anchorEnv?: BrowserEnv;
  /** The browser's CDP address when the Host already holds it; else the relay reads it from the env or the session. */
  cdpAddress?: string;
};

export interface LiveViewSession {
  /** Replays the cached status, tabs, url, any open dialog and last frame to the new subscriber first. Returns an unsubscribe function. */
  subscribe(subscriber: LiveViewSubscriber): () => void;
  /** Forwards one ordered batch of input events, all or nothing. */
  sendInput(events: readonly LiveViewInputEvent[]): Promise<LiveViewInputResult>;
  /** Answers the open confirm or prompt with that id; one answer per dialog. */
  answerDialog(answer: LiveViewDialogAnswer): Promise<LiveViewDialogResult>;
  /** Replaces the stage's current tab with a fresh one at the same URL (same browser context); the old tab closes only after the new one streams. */
  reopenTab(): Promise<LiveViewReopenResult>;
  /** Drops the cached frame so a re-target does not replay a stale page. */
  clearFrame(): void;
  /** Idempotent; subscribers receive a `closed` message. */
  close(): Promise<void>;
}

export interface LiveViewRelay {
  open(request: LiveViewSessionRequest): Promise<LiveViewSession>;
}
