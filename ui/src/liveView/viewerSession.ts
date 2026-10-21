import {
  createLiveViewConnection,
  initialLiveViewState,
  type ConnectionDeps,
  type LiveViewConnection,
  type LiveViewState,
  type TicketResult,
} from "./connection";
import { REOPEN_TAB_FAILED_NOTICE } from "./helpText";
import { dialogOutcome, DIALOG_FAILED_NOTICE, type DialogAnswerBody, type ViewerDialog } from "./dialogState";
import { registerInput, type EventTargetLike, type TextareaLike } from "./inputHandlers";
import { createInputQueue, type InputQueue, type QueueNotice } from "./inputQueue";
import type { ImageSize, LiveViewInput, LiveViewMode, ViewRect } from "./types";

export const INPUT_NOTICE_TEXT: Record<QueueNotice, string> = {
  rejected: "Some input was rejected.",
  overflow: "Too much input at once; some was dropped.",
  network: "Some input could not be sent.",
};

export type ViewerSurface = {
  canvas: EventTargetLike;
  textarea: TextareaLike | null;
  win: EventTargetLike;
  getRect(): ViewRect;
  getImageSize(): ImageSize | null;
  drawFrame(data: string): void;
};

export type ViewerSessionDeps = {
  mode: LiveViewMode;
  baseUrl: string;
  surface: ViewerSurface;
  requestTicket(baseUrl: string, mode: LiveViewMode): Promise<TicketResult>;
  postInput(baseUrl: string, batch: LiveViewInput[]): Promise<number>;
  postDialog(baseUrl: string, body: DialogAnswerBody): Promise<number>;
  postReopenTab(baseUrl: string): Promise<number>;
  openEventSource: ConnectionDeps["openEventSource"];
  setTimer(fn: () => void, ms: number): () => void;
  now(): number;
  connection?: Pick<ConnectionDeps, "maxFailures" | "baseDelayMs" | "maxDelayMs" | "noticeMs">;
};

export type ViewerSnapshot = {
  connection: LiveViewState;
  inputStopped: boolean;
  inputNotice: string | null;
  /** The dialog to show, already excluding one this operator has answered. */
  dialog: ViewerDialog | null;
  answering: boolean;
  answerFailed: string | null;
  reopeningTab: boolean;
  reopenTabFailed: string | null;
};

export type ViewerSession = {
  getState(): ViewerSnapshot;
  subscribe(listener: () => void): () => void;
  start(): void;
  /** Tear down and restart connection and input from scratch (same target). */
  reopen(): void;
  answerDialog(body: DialogAnswerBody): void;
  /** Asks the Host to replace the stage's browser tab; the stream and input keep running through the re-target. */
  reopenTab(): void;
  dispose(): void;
};

export function createViewerSession(deps: ViewerSessionDeps): ViewerSession {
  const control = deps.mode === "control";
  const listeners = new Set<() => void>();
  let connState: LiveViewState = initialLiveViewState;
  let inputStopped = false;
  let inputNotice: string | null = null;
  let answeredId: string | null = null;
  let answering = false;
  let answerFailed: string | null = null;
  let reopeningTab = false;
  let reopenTabFailed: string | null = null;
  let snapshot = compute();
  let connection: LiveViewConnection | undefined;
  let queue: InputQueue | undefined;
  let queueDead = true;
  let detachInput: (() => void) | undefined;
  let epoch = 0;
  let disposed = false;

  function compute(): ViewerSnapshot {
    const d = connState.dialog;
    return {
      connection: connState,
      inputStopped,
      inputNotice,
      dialog: d !== null && d.id !== answeredId ? d : null,
      answering,
      answerFailed,
      reopeningTab,
      reopenTabFailed,
    };
  }

  function emit(): void {
    if (disposed) return;
    snapshot = compute();
    for (const l of [...listeners]) l();
  }

  function startQueue(): void {
    queue?.stop();
    inputStopped = false;
    inputNotice = null;
    queueDead = false;
    const mine = createInputQueue({
      post: (batch) => deps.postInput(deps.baseUrl, batch),
      sleep: (ms) => new Promise<void>((resolve) => void deps.setTimer(resolve, ms)),
      now: deps.now,
      refreshSession: () => connection?.refresh() ?? Promise.resolve(false),
      onNotice: (n) => {
        if (queue !== mine) return;
        inputNotice = INPUT_NOTICE_TEXT[n];
        emit();
      },
      onStopped: () => {
        if (queue !== mine) return;
        queueDead = true;
        inputStopped = true;
        emit();
      },
    });
    queue = mine;
  }

  function stopQueueSilently(): void {
    queue?.stop();
    queueDead = true;
  }

  function onConnectionState(next: LiveViewState): void {
    const prev = connState;
    connState = next;
    if (next.dialog !== prev.dialog) {
      if (next.dialog === null || !next.dialog.autoClosed) {
        answeredId = null;
        answering = false;
        answerFailed = null;
      }
    }
    if (control) {
      if (next.phase === "closed") {
        stopQueueSilently();
      } else if (prev.phase === "reconnecting" && next.phase !== "reconnecting" && queueDead) {
        startQueue();
      }
    }
    emit();
  }

  function openConnection(): void {
    const mine = ++epoch;
    const conn = createLiveViewConnection({
      ...deps.connection,
      mode: deps.mode,
      baseUrl: deps.baseUrl,
      requestTicket: (m) => deps.requestTicket(deps.baseUrl, m),
      openEventSource: deps.openEventSource,
      setTimer: deps.setTimer,
      onState: (s) => {
        if (epoch === mine) onConnectionState(s);
      },
      onFrame: (f) => {
        if (epoch === mine) deps.surface.drawFrame(f.data);
      },
    });
    connection = conn;
    conn.start();
  }

  function closeConnection(): void {
    epoch += 1;
    connection?.dispose();
    connection = undefined;
  }

  function attachInput(): void {
    detachInput = registerInput({
      mode: deps.mode,
      canvas: deps.surface.canvas,
      textarea: deps.surface.textarea,
      win: deps.surface.win,
      getRect: deps.surface.getRect,
      getImageSize: deps.surface.getImageSize,
      send: (e) => queue?.push(e),
      now: deps.now,
      setTimer: deps.setTimer,
    });
  }

  function resetState(): void {
    connState = initialLiveViewState;
    inputStopped = false;
    inputNotice = null;
    answeredId = null;
    answering = false;
    answerFailed = null;
    reopeningTab = false;
    reopenTabFailed = null;
  }

  return {
    getState: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start() {
      if (disposed) return;
      resetState();
      emit();
      if (control) {
        startQueue();
        attachInput();
      }
      openConnection();
    },
    reopen() {
      if (disposed) return;
      closeConnection();
      resetState();
      if (control) startQueue();
      emit();
      openConnection();
    },
    answerDialog(body) {
      if (disposed) return;
      answering = true;
      answerFailed = null;
      emit();
      const mine = epoch;
      deps
        .postDialog(deps.baseUrl, body)
        .then((status) => {
          if (epoch !== mine) return;
          if (dialogOutcome(status) === "failed") answerFailed = DIALOG_FAILED_NOTICE;
          else answeredId = body.id;
        })
        .catch(() => {
          if (epoch === mine) answerFailed = DIALOG_FAILED_NOTICE;
        })
        .finally(() => {
          if (epoch !== mine) return;
          answering = false;
          emit();
        });
    },
    reopenTab() {
      if (disposed || !control || reopeningTab) return;
      reopeningTab = true;
      reopenTabFailed = null;
      emit();
      const mine = epoch;
      deps
        .postReopenTab(deps.baseUrl)
        .then((status) => {
          if (epoch === mine && status !== 200) reopenTabFailed = REOPEN_TAB_FAILED_NOTICE;
        })
        .catch(() => {
          if (epoch === mine) reopenTabFailed = REOPEN_TAB_FAILED_NOTICE;
        })
        .finally(() => {
          if (epoch !== mine) return;
          reopeningTab = false;
          emit();
        });
    },
    dispose() {
      if (disposed) return;
      closeConnection();
      detachInput?.();
      detachInput = undefined;
      queue?.stop();
      queue = undefined;
      queueDead = true;
      disposed = true;
      listeners.clear();
    },
  };
}
