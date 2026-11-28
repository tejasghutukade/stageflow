import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { ToolCallBody } from "../liveHtml/bindingCalls";
import { COLLAPSED_SHELL_HEIGHT_PX, createHostBridge, createNonce, type HostBridge } from "../liveHtml/hostBridge";
import { readLiveHtmlHostContext } from "../liveHtml/hostContext";

/** An increase that follows the previous report within this long is the page answering its own resize. */
export const HEIGHT_LOOP_WINDOW_MS = 250;

export type HeightGuard = ((reported: number) => number | null) & {
  /** Forget the lock and the run of increases: the content changed (new binding data), so it may grow again. */
  reset(): void;
};

/**
 * Stops a page that sizes itself to its own frame (e.g. `min-height: 100vh` plus padding) from growing without end:
 * each resize makes the page taller by the same amount and the page reports the new height right away. Three equal
 * increases in a row, each within HEIGHT_LOOP_WINDOW_MS of the report before it, are that loop; the height then stays
 * one step above where it started. Slower equal growth (rows arriving over time) is real content and never locks.
 */
export function createHeightGuard(now: () => number = Date.now): HeightGuard {
  let current: number | null = null;
  let start: number | null = null;
  let deltas: number[] = [];
  let locked: number | null = null;
  let lastAt: number | null = null;
  const guard = (reported: number): number | null => {
    const at = now();
    const quick = lastAt !== null && at - lastAt <= HEIGHT_LOOP_WINDOW_MS;
    lastAt = at;
    if (locked !== null) return reported < locked ? reported : null;
    if (current !== null && reported > current) {
      const delta = reported - current;
      if (!quick) deltas = [];
      if (deltas.length === 0) start = current;
      deltas.push(delta);
      if (deltas.length >= 3 && deltas.slice(-3).every((value) => value === delta)) {
        locked = (start ?? current) + delta;
        current = locked;
        return locked;
      }
    } else {
      deltas = [];
    }
    current = reported;
    return reported;
  };
  return Object.assign(guard, {
    reset() {
      current = null;
      start = null;
      deltas = [];
      locked = null;
      lastAt = null;
    },
  });
}

const NO_BINDING: (name: string) => Promise<ToolCallBody> = async () => ({
  content: [{ type: "text", text: "{}" }],
  structuredContent: null,
  isError: true,
  _meta: { source: "executed", fetched_at: new Date().toISOString() },
});

export type SandboxBridgeInput = {
  origin: string;
  html: string;
  csp: string;
  libraries: Array<{ name: string; version: string }>;
  allowEval: boolean;
  /** Height before the page reports one; null leaves sizing to the caller's CSS. */
  initialHeight: number | null;
  /** The shell did not load in time. Read when the timer fires, so it may change between renders. */
  onTimeout: () => void;
  callBinding?: (name: string, args: Record<string, unknown> | undefined) => Promise<ToolCallBody>;
  onLinkBlocked?: () => void;
  onSandboxError?: (reason: unknown) => void;
  /** Runs before the frame is bound on mount, and after it is unbound on unmount. */
  onBind?: () => void;
  onUnbind?: () => void;
};

export type SandboxBridge = {
  iframeRef: RefObject<HTMLIFrameElement | null>;
  containerRef: RefObject<HTMLDivElement | null>;
  bridge: HostBridge;
  phase: "loading" | "live";
  height: number | null;
  /** Set once the sandbox stops the page (navigation, CSP refusal, limits); the frame collapses. */
  stopped: { reason: unknown } | null;
  src: string;
  /** Tell the page a binding has new data; the height guard unlocks so the page can grow to fit it. */
  notifyBindingUpdated: (bindingId: string) => void;
};

/**
 * The frame core shared by HTML cards and the live HTML artifact view: one host bridge per mount, the message relay
 * with a mount epoch, bind/arm on mount and unbind/disarm on unmount, the stopped state and the guarded height.
 * Mount a fresh component (a new `key`) for new content; the bridge is built once.
 */
export function useSandboxBridge(input: SandboxBridgeInput): SandboxBridge {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<"loading" | "live">("loading");
  const [height, setHeight] = useState<number | null>(input.initialHeight);
  const [stopped, setStopped] = useState<{ reason: unknown } | null>(null);
  const [heightGuard] = useState(() => createHeightGuard());
  const [nonce] = useState(createNonce);
  const latest = useRef(input);
  latest.current = input;
  const bridgeRef = useRef<HostBridge | null>(null);
  if (bridgeRef.current === null) {
    bridgeRef.current = createHostBridge({
      sandboxOrigin: input.origin,
      html: input.html,
      csp: input.csp,
      nonce,
      libraries: input.libraries,
      allowEval: input.allowEval,
      readContext: () => readLiveHtmlHostContext(containerRef.current),
      callBinding: input.callBinding ?? NO_BINDING,
      onHeight: (px) => {
        const next = heightGuard(px);
        if (next !== null) setHeight(next);
      },
      onLinkBlocked: () => latest.current.onLinkBlocked?.(),
      onReady: () => setPhase("live"),
      onSandboxError: (reason) => {
        latest.current.onSandboxError?.(reason);
        setHeight(COLLAPSED_SHELL_HEIGHT_PX);
        setStopped({ reason });
      },
    });
  }
  const bridge = bridgeRef.current;

  useLayoutEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    latest.current.onBind?.();
    const epoch = { current: 0 };
    const token = ++epoch.current;
    const isCurrent = () => epoch.current === token;
    const onMessage = (event: MessageEvent) => {
      const frame = iframe.contentWindow;
      bridge.onMessage(event, frame, (message, targetOrigin) => {
        frame?.postMessage(message, targetOrigin);
      }, isCurrent);
    };
    bridge.bind((message, targetOrigin) => {
      iframe.contentWindow?.postMessage(message, targetOrigin);
    });
    window.addEventListener("message", onMessage);
    bridge.arm(() => latest.current.onTimeout());
    return () => {
      epoch.current += 1;
      latest.current.onUnbind?.();
      window.removeEventListener("message", onMessage);
      bridge.bind(null);
      bridge.disarm();
    };
  }, [bridge]);

  const parent = typeof location === "undefined" ? "" : location.origin;
  const src = `${input.origin}/shell.html?parent=${encodeURIComponent(parent)}`;
  const notifyBindingUpdated = (bindingId: string) => {
    heightGuard.reset();
    bridge.notifyBindingUpdated(bindingId);
  };
  return { iframeRef, containerRef, bridge, phase, height, stopped, src, notifyBindingUpdated };
}
