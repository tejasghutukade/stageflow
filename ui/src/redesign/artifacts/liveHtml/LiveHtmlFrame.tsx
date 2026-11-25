import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { queryArtifactBinding, type ArtifactRecord, type ArtifactSnapshot } from "../../../api/artifacts";
import { canonicalJson, clearLiveQueryCache } from "../liveData/queryCache";
import { SandboxedHtml } from "../renderers/SandboxedHtml";
import { bindingCacheScope, createBindingCaller, type BindingQuery } from "./bindingCalls";
import { liveHtmlDocumentCsp } from "./cspPolicy";
import { COLLAPSED_SHELL_HEIGHT_PX, createHostBridge, createNonce, type HostBridge } from "./hostBridge";
import { readLiveHtmlHostContext } from "./hostContext";
import { useSandboxOrigin } from "./sandboxOrigin";

const LINK_NOTE_MS = 5_000;

function sandboxStoppedMessage(reason: unknown): string {
  if (reason === "navigated") return "This artifact tried to navigate away and was stopped for your safety.";
  if (reason === "csp") return "The sandbox refused this artifact's security policy (this is a bug: please report it).";
  return "The sandbox stopped this artifact.";
}

function sandboxReasonLabel(reason: unknown): string {
  if (typeof reason === "string" && /^[a-z][a-z0-9_-]{0,63}$/.test(reason)) return reason;
  return "unknown";
}

const FALLBACK_NOTICE =
  "Live preview needs the sandbox origin, which is not available on this Host. Showing a static preview with scripts disabled.";

export type LiveHtmlFrameProps = {
  record: ArtifactRecord;
  version: number;
  html: string | null;
  htmlError: string | null;
  historical: boolean;
  snapshots: readonly ArtifactSnapshot[];
  settled: boolean;
  refreshing?: boolean;
  ownerKey: string;
  artifactId: string;
  projectRoot?: string;
  query?: BindingQuery;
};

function LoadingSkeleton() {
  return (
    <div role="status" data-sf-state="Loading" className="flex flex-col gap-2" aria-label="Loading">
      <div className="h-4 w-1/3 animate-pulse rounded bg-[var(--sf-raised)]" />
      <div className="h-24 animate-pulse rounded-lg bg-[var(--sf-raised)]" />
      <div className="h-4 w-2/3 animate-pulse rounded bg-[var(--sf-raised)]" />
    </div>
  );
}

function StateCard({ title, body, children }: { title: string; body?: string; children?: ReactNode }) {
  return (
    <div role="alert" data-sf-state={title} className="rounded-lg border border-[var(--sf-hairline)] bg-[var(--sf-panel)] px-4 py-3">
      <p className="text-[13px] font-medium text-[var(--sf-text-1)]">{title}</p>
      {body ? <p className="mt-1 text-[13px] text-[var(--sf-text-2)]">{body}</p> : null}
      {children}
    </div>
  );
}

function HtmlSource({ html }: { html: string }) {
  return <pre className="sf-mono whitespace-pre-wrap text-[13px] text-[var(--sf-text-1)]">{html}</pre>;
}

function snapshotCanon(snapshots: readonly ArtifactSnapshot[]): string {
  return canonicalJson(snapshots.map((item) => [item.binding_id, item.value, item.fetched_at, item.source]));
}

export function LiveHtmlFrame(props: LiveHtmlFrameProps) {
  const sandbox = useSandboxOrigin();
  const format = props.record.live?.format;
  const canonRef = useRef<string | null>(null);
  const refreshingRef = useRef(false);
  const canon = snapshotCanon(props.snapshots);
  if (canonRef.current === null) canonRef.current = canon;
  else if (canonRef.current !== canon) {
    canonRef.current = canon;
    clearLiveQueryCache();
  }
  if (props.refreshing === true && !refreshingRef.current) clearLiveQueryCache();
  refreshingRef.current = props.refreshing === true;

  if (format !== undefined && format !== "html") {
    return <StateCard title="Library n/a" body="This artifact's format is not HTML. Live HTML has no component library." />;
  }
  if (props.htmlError) {
    return <StateCard title="Could not load the HTML" body={props.htmlError} />;
  }
  if (props.html === null || !sandbox.ready) return <LoadingSkeleton />;
  if (sandbox.origin === null) {
    return (
      <div data-testid="live-html-fallback" className="flex flex-col gap-3">
        <p className="text-[13px] text-[var(--sf-text-2)]">{FALLBACK_NOTICE}</p>
        <a data-docs="live-html-sandbox">Live HTML artifacts: the sandbox origin</a>
        <SandboxedHtml text={props.html} source={<HtmlSource html={props.html} />} />
      </div>
    );
  }
  return <LiveHtmlMount {...props} html={props.html} origin={sandbox.origin} />;
}

function LiveHtmlMount(props: LiveHtmlFrameProps & { html: string; origin: string }) {
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
  }, [props.html, props.record.live?.csp, props.version, props.origin]);
  if (failed) {
    return (
      <StateCard title="The sandbox did not start">
        <button
          type="button"
          className="mt-3 h-8 rounded-lg border border-[var(--sf-hairline-strong)] px-3 text-[13px] text-[var(--sf-text-1)]"
          onClick={() => {
            setFailed(false);
            setAttempt((value) => value + 1);
          }}
        >
          Retry
        </button>
        <details className="mt-3">
          <summary className="cursor-pointer text-[13px] text-[var(--sf-text-2)]">Details</summary>
          <p className="sf-mono mt-1 text-[12px] text-[var(--sf-text-1)]">{props.origin}</p>
        </details>
      </StateCard>
    );
  }
  const csp = liveHtmlDocumentCsp(props.record.live?.csp ?? {});
  return (
    <LiveHtmlSession
      key={`${attempt}:${props.version}:${csp}:${props.html}`}
      {...props}
      csp={csp}
      onTimeout={() => setFailed(true)}
      onRestart={() => {
        setFailed(false);
        setAttempt((value) => value + 1);
      }}
    />
  );
}

function LiveHtmlSession(props: LiveHtmlFrameProps & {
  html: string;
  origin: string;
  csp: string;
  onTimeout: () => void;
  onRestart: () => void;
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<"loading" | "live">("loading");
  const [height, setHeight] = useState<number | null>(null);
  const [linkNote, setLinkNote] = useState(false);
  const [stoppedReason, setStoppedReason] = useState<{ reason: unknown } | null>(null);
  const linkTimer = useRef<number | null>(null);
  const snapshotsRef = useRef(props.snapshots);
  const settledRef = useRef(props.settled);
  const refreshingRef = useRef(props.refreshing === true);
  const queryRef = useRef(props.query);
  snapshotsRef.current = props.snapshots;
  settledRef.current = props.settled;
  refreshingRef.current = props.refreshing === true;
  queryRef.current = props.query;
  const waitersRef = useRef<ReturnType<typeof createWaiters> | null>(null);
  if (waitersRef.current === null) {
    waitersRef.current = createWaiters(
      () => snapshotsRef.current,
      () => !settledRef.current || refreshingRef.current,
    );
  }
  const bridgeRef = useRef<HostBridge | null>(null);
  const [nonce] = useState(createNonce);
  const onTimeoutRef = useRef(props.onTimeout);
  onTimeoutRef.current = props.onTimeout;
  if (bridgeRef.current === null) {
    const bindings = props.record.live?.bindings ?? [];
    const caller = createBindingCaller({
      bindings,
      getSnapshots: () => snapshotsRef.current,
      historical: props.historical,
      pending: () => !settledRef.current || refreshingRef.current,
      aborted: () => waitersRef.current?.aborted() ?? false,
      waitForSnapshot: (bindingId, timeoutMs) => waitersRef.current!.wait(bindingId, timeoutMs),
      query: (input) => {
        const custom = queryRef.current;
        if (custom) return custom(input);
        return queryArtifactBinding(
          props.ownerKey,
          props.artifactId,
          { binding_id: input.bindingId, args: input.args },
          props.projectRoot,
        );
      },
      cacheScope: bindingCacheScope(props.projectRoot, props.ownerKey, props.artifactId, props.version),
    });
    bridgeRef.current = createHostBridge({
      sandboxOrigin: props.origin,
      html: props.html,
      csp: props.csp,
      nonce,
      readContext: () => readLiveHtmlHostContext(containerRef.current),
      callBinding: caller,
      onHeight: (px) => setHeight(px),
      onLinkBlocked: () => {
        setLinkNote(true);
        if (linkTimer.current !== null) window.clearTimeout(linkTimer.current);
        linkTimer.current = window.setTimeout(() => {
          linkTimer.current = null;
          setLinkNote(false);
        }, LINK_NOTE_MS);
      },
      onReady: () => setPhase("live"),
      onSandboxError: (reason) => {
        if (linkTimer.current !== null) {
          window.clearTimeout(linkTimer.current);
          linkTimer.current = null;
        }
        setLinkNote(false);
        setHeight(COLLAPSED_SHELL_HEIGHT_PX);
        setStoppedReason({ reason });
      },
    });
  }

  useEffect(() => {
    waitersRef.current?.notify();
  }, [props.snapshots, props.settled, props.refreshing]);

  const seenValues = useRef<Map<string, string> | null>(null);
  useEffect(() => {
    const previous = seenValues.current;
    const next = new Map<string, string>();
    for (const snap of props.snapshots) {
      const hash = canonicalJson(snap.value === undefined ? null : snap.value);
      next.set(snap.binding_id, hash);
      if (previous && previous.get(snap.binding_id) !== hash) {
        bridgeRef.current?.notifyBindingUpdated(snap.binding_id);
      }
    }
    seenValues.current = next;
  }, [props.snapshots]);

  useLayoutEffect(() => {
    const bridge = bridgeRef.current;
    const iframe = iframeRef.current;
    if (!bridge || !iframe) return;
    waitersRef.current?.reset();
    const epoch = { current: 0 };
    const token = ++epoch.current;
    const isCurrent = () => epoch.current === token;
    const onMessage = (event: MessageEvent) => {
      const frame = iframe.contentWindow;
      bridge.onMessage(event, frame, (message, targetOrigin) => {
        frame?.postMessage(message, targetOrigin);
      }, isCurrent);
    };
    const post = (message: unknown, targetOrigin: string) => {
      iframe.contentWindow?.postMessage(message, targetOrigin);
    };
    bridge.bind(post);
    window.addEventListener("message", onMessage);
    bridge.arm(() => onTimeoutRef.current());
    return () => {
      epoch.current += 1;
      waitersRef.current?.cancel();
      window.removeEventListener("message", onMessage);
      bridge.bind(null);
      bridge.disarm();
    };
  }, []);

  useEffect(() => {
    return () => {
      if (linkTimer.current !== null) window.clearTimeout(linkTimer.current);
    };
  }, []);

  const parent = typeof location === "undefined" ? "" : location.origin;
  const src = `${props.origin}/shell.html?parent=${encodeURIComponent(parent)}`;
  const stopped = stoppedReason !== null;
  const frameHeight = stopped ? COLLAPSED_SHELL_HEIGHT_PX : height;
  return (
    <div ref={containerRef} data-testid="live-html-frame" className="flex flex-col gap-3">
      {stoppedReason ? (
        <StateCard title="Sandbox stopped" body={sandboxStoppedMessage(stoppedReason.reason)}>
          <button
            type="button"
            className="mt-3 h-8 rounded-lg border border-[var(--sf-hairline-strong)] px-3 text-[13px] text-[var(--sf-text-1)]"
            onClick={() => props.onRestart()}
          >
            Retry
          </button>
          <details className="mt-3">
            <summary className="cursor-pointer text-[13px] text-[var(--sf-text-2)]">Details</summary>
            <p className="sf-mono mt-1 text-[12px] text-[var(--sf-text-1)]">{sandboxReasonLabel(stoppedReason.reason)}</p>
            <p className="sf-mono mt-1 text-[12px] text-[var(--sf-text-1)]">{props.origin}</p>
          </details>
        </StateCard>
      ) : null}
      <div className={stopped ? "contents" : "relative min-h-[480px] w-full overflow-hidden rounded-lg border border-[var(--sf-hairline)] bg-[var(--sf-panel)]"}>
        {!stopped && phase === "loading" ? (
          <div className="absolute inset-0 p-3">
            <LoadingSkeleton />
          </div>
        ) : null}
        <iframe
          ref={iframeRef}
          title="Live HTML artifact"
          sandbox="allow-scripts allow-same-origin"
          referrerPolicy="no-referrer"
          loading="eager"
          src={src}
          data-testid="live-html-shell"
          data-collapsed={stopped ? "true" : "false"}
          aria-hidden={stopped ? true : undefined}
          style={frameHeight === null ? undefined : { height: frameHeight, minHeight: frameHeight }}
          className={`block w-full border-0 ${stopped || frameHeight !== null ? "" : "min-h-[480px]"} ${!stopped && phase === "loading" ? "invisible" : ""}`}
        />
      </div>
      {linkNote ? (
        <p role="status" data-testid="live-html-link-note" className="text-[13px] text-[var(--sf-text-2)]">
          A link in this artifact was blocked
        </p>
      ) : null}
    </div>
  );
}

function createWaiters(read: () => readonly ArtifactSnapshot[], pendingData: () => boolean) {
  const pending = new Set<() => void>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let cancelled = false;
  return {
    aborted: () => cancelled,
    reset() {
      cancelled = false;
    },
    notify() {
      for (const check of [...pending]) check();
    },
    cancel() {
      cancelled = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      for (const check of [...pending]) check();
    },
    wait(bindingId: string, timeoutMs: number) {
      if (cancelled || read().some((item) => item.binding_id === bindingId) || !pendingData()) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const timer = setTimeout(finish, timeoutMs);
        timers.add(timer);
        function finish() {
          clearTimeout(timer);
          timers.delete(timer);
          pending.delete(check);
          resolve();
        }
        function check() {
          if (cancelled || !pendingData() || read().some((item) => item.binding_id === bindingId)) finish();
        }
        pending.add(check);
      });
    },
  };
}
