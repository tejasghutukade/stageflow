import { useLayoutEffect, useRef, useState } from "react";
import type { ToolCallBody } from "../../redesign/artifacts/liveHtml/bindingCalls";
import { HTML_LIBRARY_FLAGS } from "../../../../src/artifacts/library/htmlLibraryFlags.ts";
import { libraryCspSources, liveHtmlDocumentCsp } from "../../redesign/artifacts/liveHtml/cspPolicy";
import {
  COLLAPSED_SHELL_HEIGHT_PX,
  createHostBridge,
  createNonce,
  type HostBridge,
} from "../../redesign/artifacts/liveHtml/hostBridge";
import { readLiveHtmlHostContext } from "../../redesign/artifacts/liveHtml/hostContext";
import { chooseSandboxOrigin } from "../../hostInfo";

const NO_BINDING: (name: string) => Promise<ToolCallBody> = async () => ({
  content: [{ type: "text", text: "{}" }],
  structuredContent: null,
  isError: true,
  _meta: { source: "executed", fetched_at: new Date().toISOString() },
});

/**
 * Stops a card that sizes itself to its own frame (e.g. `min-height: 100vh` plus padding) from growing without end:
 * each resize makes the page taller by the same amount, which reports a new height, and so on up to the limit.
 * Three equal increases in a row are that loop; the height then stays one step above where it started.
 */
export function createHeightGuard(): (reported: number) => number | null {
  let current: number | null = null;
  let start: number | null = null;
  let deltas: number[] = [];
  let locked: number | null = null;
  return (reported) => {
    if (locked !== null) return reported < locked ? reported : null;
    if (current !== null && reported > current) {
      const delta = reported - current;
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
}

/** Changes whenever the card's content does, so a new program or library set mounts a fresh frame and bridge. */
function cardKey(origin: string, program: string, libraries: readonly { name: string; version: string }[]): string {
  let hash = 0;
  for (let index = 0; index < program.length; index += 1) hash = (hash * 31 + program.charCodeAt(index)) | 0;
  const libs = libraries.map((library) => `${library.name}@${library.version}`).join(",");
  return `${origin}|${(hash >>> 0).toString(36)}:${program.length}|${libs}`;
}

export function HtmlCardSandbox({
  program,
  libraries,
  sandboxOrigin,
  sandboxOrigins,
}: {
  program: string;
  libraries: readonly { name: string; version: string }[];
  sandboxOrigin?: string | null;
  sandboxOrigins?: readonly string[];
}) {
  const hostname = typeof location === "undefined" ? "localhost" : location.hostname;
  const origin = sandboxOrigin ?? chooseSandboxOrigin(null, sandboxOrigins ?? [], hostname);
  if (!origin) {
    return (
      <p className="text-[13px] text-[var(--sf-text-2)]" data-testid="html-card-no-sandbox">
        This card needs the Host&apos;s sandbox to display.
      </p>
    );
  }
  return <HtmlCardFrame key={cardKey(origin, program, libraries)} program={program} libraries={libraries} origin={origin} />;
}

type FramePhase = "loading" | "live" | "stopped";

/** One mount per card content: the bridge is built once and the effect runs once, like LiveHtmlFrame. */
function HtmlCardFrame({
  program,
  libraries,
  origin,
}: {
  program: string;
  libraries: readonly { name: string; version: string }[];
  origin: string;
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<FramePhase>("loading");
  const [height, setHeight] = useState<number>(200);
  const [setup] = useState(() => {
    const selected = libraries.flatMap((ref) => {
      const library = HTML_LIBRARY_FLAGS.find((item) => item.name === ref.name && item.version === ref.version);
      return library ? [library] : [];
    });
    const needsEval = selected.some((library) => library.needsEval);
    const csp = liveHtmlDocumentCsp({}, { ...libraryCspSources(origin, libraries), shellOrigin: origin, needsEval });
    return { csp, needsEval, nonce: createNonce(), libraryRefs: libraries.map((library) => ({ name: library.name, version: library.version })) };
  });
  const [heightGuard] = useState(createHeightGuard);
  const bridgeRef = useRef<HostBridge | null>(null);
  if (bridgeRef.current === null) {
    bridgeRef.current = createHostBridge({
      sandboxOrigin: origin,
      html: program,
      csp: setup.csp,
      nonce: setup.nonce,
      libraries: setup.libraryRefs,
      allowEval: setup.needsEval,
      readContext: () => readLiveHtmlHostContext(containerRef.current),
      callBinding: NO_BINDING,
      onHeight: (px) => {
        const next = heightGuard(px);
        if (next !== null) setHeight(next);
      },
      onLinkBlocked: () => undefined,
      onReady: () => setPhase("live"),
      onSandboxError: () => {
        setHeight(COLLAPSED_SHELL_HEIGHT_PX);
        setPhase("stopped");
      },
    });
  }

  useLayoutEffect(() => {
    const bridge = bridgeRef.current;
    const iframe = iframeRef.current;
    if (!bridge || !iframe) return;
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
    bridge.arm(() => setPhase("stopped"));
    return () => {
      epoch.current += 1;
      window.removeEventListener("message", onMessage);
      bridge.bind(null);
      bridge.disarm();
    };
  }, []);

  const parent = typeof location === "undefined" ? "" : location.origin;
  const src = `${origin}/shell.html?parent=${encodeURIComponent(parent)}`;
  return (
    <div ref={containerRef} data-testid="html-card-frame" data-csp={setup.csp}>
      {phase === "stopped" ? (
        <p role="alert" className="m-0 mb-2 text-[13px] text-[var(--sf-text-2)]" data-testid="html-card-stopped">
          This card could not be shown.
        </p>
      ) : null}
      <iframe
        ref={iframeRef}
        title="HTML card"
        sandbox="allow-scripts allow-same-origin"
        referrerPolicy="no-referrer"
        loading="eager"
        src={src}
        data-testid="html-card-shell"
        style={{ height, minHeight: height }}
        className={`block w-full border-0 rounded-md ${phase === "live" ? "" : "invisible"}`}
      />
    </div>
  );
}
