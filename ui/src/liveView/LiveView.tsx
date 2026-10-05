import { useEffect, useRef, useState } from "react";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import {
  createLiveViewConnection,
  initialLiveViewState,
  type LiveViewConnection,
  type LiveViewState,
} from "./connection";
import { postLiveViewDialog, postLiveViewInput, requestLiveViewTicket } from "./client";
import { DialogOverlay } from "./DialogOverlay";
import { dialogOutcome, DIALOG_FAILED_NOTICE, type DialogAnswerBody } from "./dialogState";
import { createFrameRenderer, type FrameRenderer } from "./frameRenderer";
import { LIVE_VIEW_HELP, LIVE_VIEW_INSTRUCTION } from "./helpText";
import { registerInput } from "./inputHandlers";
import { createInputQueue, type InputQueue, type QueueNotice } from "./inputQueue";
import type { LiveViewMode } from "./types";

const NOTICE_TEXT: Record<QueueNotice, string> = {
  rejected: "Some input was rejected.",
  overflow: "Too much input at once; some was dropped.",
  network: "Some input could not be sent.",
};

function statusLine(state: LiveViewState, inputStopped: boolean): string | null {
  if (state.phase === "closed") return state.closedReason === "unavailable" ? "Live view is unavailable" : "Closed";
  if (state.phase === "reconnecting") return "Reconnecting…";
  if (!state.hasFrame) return "Waiting for the browser…";
  if (inputStopped) return "Input stopped";
  return null;
}

export function LiveView({ handoffUrl, mode = "control" }: { handoffUrl: string; mode?: LiveViewMode }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const connectionRef = useRef<LiveViewConnection | null>(null);
  const rendererRef = useRef<FrameRenderer | null>(null);
  const queueRef = useRef<InputQueue | null>(null);
  const [state, setState] = useState<LiveViewState>(initialLiveViewState);
  const [inputNotice, setInputNotice] = useState<string | null>(null);
  const [inputStopped, setInputStopped] = useState(false);
  const [answered, setAnswered] = useState<string | null>(null);
  const [answering, setAnswering] = useState(false);
  const [answerFailed, setAnswerFailed] = useState<string | null>(null);

  const answerDialog = (body: DialogAnswerBody) => {
    setAnswering(true);
    setAnswerFailed(null);
    postLiveViewDialog(handoffUrl, body)
      .then((status) => {
        const outcome = dialogOutcome(status);
        if (outcome === "failed") setAnswerFailed(DIALOG_FAILED_NOTICE);
        else setAnswered(body.id);
      })
      .catch(() => setAnswerFailed(DIALOG_FAILED_NOTICE))
      .finally(() => setAnswering(false));
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const renderer = createFrameRenderer(canvas);
    rendererRef.current = renderer;
    const connection = createLiveViewConnection({
      mode,
      baseUrl: handoffUrl,
      requestTicket: (m) => requestLiveViewTicket(handoffUrl, m),
      openEventSource: (url) => new EventSource(url),
      setTimer: (fn, ms) => {
        const handle = setTimeout(fn, ms);
        return () => clearTimeout(handle);
      },
      onState: setState,
      onFrame: (frame) => renderer.draw(frame.data),
    });
    connectionRef.current = connection;
    setState(initialLiveViewState);
    connection.start();
    return () => {
      connection.dispose();
      renderer.dispose();
      connectionRef.current = null;
      rendererRef.current = null;
    };
  }, [handoffUrl, mode]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (mode !== "control" || canvas === null) return;
    setInputStopped(false);
    setInputNotice(null);
    const queue = createInputQueue({
      post: (batch) => postLiveViewInput(handoffUrl, batch),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: () => performance.now(),
      refreshSession: () => connectionRef.current?.refresh() ?? Promise.resolve(false),
      onNotice: (n) => setInputNotice(NOTICE_TEXT[n]),
      onStopped: () => setInputStopped(true),
    });
    queueRef.current = queue;
    const detach = registerInput({
      mode,
      canvas,
      textarea: textareaRef.current,
      win: window,
      getRect: () => canvas.getBoundingClientRect(),
      getImageSize: () => rendererRef.current?.size() ?? null,
      send: queue.push,
      now: () => performance.now(),
      setTimer: (fn, ms) => {
        const handle = setTimeout(fn, ms);
        return () => clearTimeout(handle);
      },
    });
    return () => {
      detach();
      queue.stop();
      queueRef.current = null;
    };
  }, [handoffUrl, mode]);

  useEffect(() => {
    if (state.phase === "closed") queueRef.current?.stop();
  }, [state.phase]);

  const line = statusLine(state, inputStopped);
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
        {state.dialog !== null && state.dialog.id !== answered ? (
          <DialogOverlay
            dialog={state.dialog}
            mode={mode}
            busy={answering}
            failed={answerFailed}
            onAnswer={answerDialog}
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
      </Collapsible>
    </section>
  );
}
