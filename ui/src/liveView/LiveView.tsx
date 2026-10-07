import { useEffect, useRef, useState } from "react";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { initialLiveViewState, type LiveViewState } from "./connection";
import { postLiveViewDialog, postLiveViewInput, postLiveViewReopenTab, requestLiveViewTicket } from "./client";
import { DialogOverlay } from "./DialogOverlay";
import { createFrameRenderer } from "./frameRenderer";
import { LIVE_VIEW_HELP, LIVE_VIEW_INSTRUCTION, REOPEN_TAB_LABEL } from "./helpText";
import type { LiveViewMode } from "./types";
import { createViewerSession, type ViewerSession, type ViewerSnapshot } from "./viewerSession";

const INITIAL_SNAPSHOT: ViewerSnapshot = {
  connection: initialLiveViewState,
  inputStopped: false,
  inputNotice: null,
  dialog: null,
  answering: false,
  answerFailed: null,
  reopeningTab: false,
  reopenTabFailed: null,
};

function statusLine(state: LiveViewState, inputStopped: boolean): string | null {
  if (state.phase === "closed") return state.closedReason === "unavailable" ? "Live view is unavailable" : "Closed";
  if (state.phase === "reconnecting") return "Reconnecting…";
  if (!state.hasFrame) return "Waiting for the browser…";
  if (inputStopped) return "Input stopped";
  return null;
}

export function LiveView({
  handoffUrl,
  mode = "control",
  reopenKey,
}: {
  handoffUrl: string;
  mode?: LiveViewMode;
  /** Change to force a fresh connection and input restart for the same handoff URL (e.g. a gate re-asked). */
  reopenKey?: unknown;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const sessionRef = useRef<ViewerSession | null>(null);
  const seenReopenKey = useRef(reopenKey);
  const [snapshot, setSnapshot] = useState<ViewerSnapshot>(INITIAL_SNAPSHOT);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const renderer = createFrameRenderer(canvas);
    const session = createViewerSession({
      mode,
      baseUrl: handoffUrl,
      surface: {
        canvas,
        textarea: textareaRef.current,
        win: window,
        getRect: () => canvas.getBoundingClientRect(),
        getImageSize: () => renderer.size(),
        drawFrame: (data) => renderer.draw(data),
      },
      requestTicket: requestLiveViewTicket,
      postInput: postLiveViewInput,
      postDialog: postLiveViewDialog,
      postReopenTab: postLiveViewReopenTab,
      openEventSource: (url) => new EventSource(url),
      setTimer: (fn, ms) => {
        const handle = setTimeout(fn, ms);
        return () => clearTimeout(handle);
      },
      now: () => performance.now(),
    });
    sessionRef.current = session;
    setSnapshot(session.getState());
    const unsubscribe = session.subscribe(() => setSnapshot(session.getState()));
    session.start();
    return () => {
      unsubscribe();
      session.dispose();
      renderer.dispose();
      sessionRef.current = null;
    };
  }, [handoffUrl, mode]);

  useEffect(() => {
    if (Object.is(seenReopenKey.current, reopenKey)) return;
    seenReopenKey.current = reopenKey;
    sessionRef.current?.reopen();
  }, [reopenKey]);

  const state = snapshot.connection;
  const { inputNotice, dialog } = snapshot;

  const line = statusLine(state, snapshot.inputStopped);
  const closed = state.phase === "closed";

  return (
    <section className="liveview" aria-label="Browser view">
      <p className="liveview__instruction">{LIVE_VIEW_INSTRUCTION}</p>
      <div className="liveview__address" title={state.url}>
        {state.url || " "}
      </div>
      {state.notice !== null ? <p className="liveview__notice">{state.notice}</p> : null}
      {inputNotice !== null ? <p className="liveview__notice">{inputNotice}</p> : null}
      <div className="liveview__stage" data-phase={state.phase}>
        <canvas
          ref={canvasRef}
          className={`liveview__canvas${mode === "control" && !closed ? " liveview__canvas--control" : ""}`}
          width={1280}
          height={720}
        />
        {dialog !== null ? (
          <DialogOverlay
            dialog={dialog}
            mode={mode}
            busy={snapshot.answering}
            failed={snapshot.answerFailed}
            onAnswer={(body) => sessionRef.current?.answerDialog(body)}
          />
        ) : null}
        {line !== null ? (
          <div className="liveview__status" role="status">
            {line}
          </div>
        ) : null}
      </div>
      {mode === "control" ? (
        <textarea
          ref={textareaRef}
          className="liveview__kb"
          aria-label="Keyboard input for the browser view"
          autoCapitalize="off"
          autoComplete="off"
          spellCheck={false}
          tabIndex={-1}
        />
      ) : null}
      <Collapsible trigger={<span className="liveview__help-trigger">Page seems stuck?</span>}>
        <p className="liveview__help">{LIVE_VIEW_HELP}</p>
        {mode === "control" ? (
          <div className="liveview__help-actions">
            <button
              type="button"
              className="btn btn--ghost"
              disabled={snapshot.reopeningTab || closed}
              onClick={() => sessionRef.current?.reopenTab()}
            >
              {snapshot.reopeningTab ? "Reopening…" : REOPEN_TAB_LABEL}
            </button>
            {snapshot.reopenTabFailed !== null ? (
              <p className="liveview__notice" role="status">
                {snapshot.reopenTabFailed}
              </p>
            ) : null}
          </div>
        ) : null}
      </Collapsible>
    </section>
  );
}
