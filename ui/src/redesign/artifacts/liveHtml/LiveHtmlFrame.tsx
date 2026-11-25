import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { LuShieldAlert } from "react-icons/lu";
import {
  approveArtifactOrigins,
  queryArtifactBinding,
  revokeArtifactOrigins,
  type ArtifactLiveView,
  type ArtifactOriginView,
  type ArtifactRecord,
  type ArtifactSnapshot,
} from "../../../api/artifacts";
import { canonicalJson, clearLiveQueryCache } from "../liveData/queryCache";
import { SandboxedHtml } from "../renderers/SandboxedHtml";
import { bindingCacheScope, createBindingCaller, type BindingQuery } from "./bindingCalls";
import { HTML_LIBRARY_FLAGS } from "../../../../../src/artifacts/library/htmlLibraryFlags.ts";
import { libraryCspSources, liveHtmlDocumentCsp } from "./cspPolicy";
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
  onOrigins?: (origins: ArtifactOriginView) => void;
  reviewToken?: number;
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

function originKey(origins: ArtifactOriginView | undefined): string {
  if (!origins) return "";
  return `${origins.hash}:${origins.approved}:${origins.approved_at ?? ""}`;
}

function declaredOriginLists(csp: ArtifactLiveView["csp"]): { connect: string[]; resource: string[]; base: string[] } {
  return {
    connect: csp?.connectDomains ?? [],
    resource: csp?.resourceDomains ?? [],
    base: csp?.baseUriDomains ?? [],
  };
}

function hasDeclaredOrigins(lists: { connect: string[]; resource: string[]; base: string[] }): boolean {
  return lists.connect.length + lists.resource.length + lists.base.length > 0;
}

function approvalView(record: ArtifactRecord): { view: ArtifactOriginView | null; blocked: boolean; hashKnown: boolean } {
  const lists = declaredOriginLists(record.live?.csp);
  const origins = record.live?.origins;
  if (!hasDeclaredOrigins(lists) && (!origins || origins.connect.length + origins.resource.length + origins.base.length === 0)) {
    return { view: origins ?? null, blocked: false, hashKnown: true };
  }
  if (!hasDeclaredOrigins(lists)) {
    return { view: origins ?? null, blocked: Boolean(origins && !origins.approved && origins.connect.length + origins.resource.length + origins.base.length > 0), hashKnown: Boolean(origins?.hash) };
  }
  if (!origins || !origins.approved) {
    const view = origins ?? { ...lists, hash: "", approved: false, approved_at: null };
    return { view, blocked: true, hashKnown: Boolean(origins?.hash) };
  }
  return { view: origins, blocked: false, hashKnown: true };
}

function LiveHtmlMount(props: LiveHtmlFrameProps & { html: string; origin: string }) {
  const [attempt, setAttempt] = useState(0);
  const [frameEpoch, setFrameEpoch] = useState(0);
  const [failed, setFailed] = useState(false);
  const incomingKey = `${originKey(props.record.live?.origins)}:${declaredOriginLists(props.record.live?.csp).connect.join(",")}:${declaredOriginLists(props.record.live?.csp).resource.join(",")}:${declaredOriginLists(props.record.live?.csp).base.join(",")}`;
  const [seenKey, setSeenKey] = useState(incomingKey);
  const [origins, setOrigins] = useState<ArtifactOriginView | null>(approvalView(props.record).view);
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const review = props.reviewToken ?? 0;
  const [seenReview, setSeenReview] = useState(review);
  if (seenKey !== incomingKey) {
    setSeenKey(incomingKey);
    setOrigins(approvalView(props.record).view);
    setDismissed(false);
    setActionError(null);
  }
  if (seenReview !== review) {
    setSeenReview(review);
    setDismissed(false);
  }
  useEffect(() => {
    setFailed(false);
  }, [props.html, props.record.live?.csp, props.version, props.origin, frameEpoch]);
  const declared = props.record.live?.libraries ?? [];
  const selected = declared.flatMap((ref) => {
    const library = HTML_LIBRARY_FLAGS.find((item) => item.name === ref.name && item.version === ref.version);
    return library ? [library] : [];
  });
  const lists = declaredOriginLists(props.record.live?.csp);
  const listed = origins ? origins.connect.length + origins.resource.length + origins.base.length : 0;
  const declaredOrigins = hasDeclaredOrigins(lists);
  const blocked = declaredOrigins ? origins?.approved !== true : listed > 0 && origins?.approved !== true;
  const requested = blocked
    ? listed > 0
      ? origins
      : declaredOrigins
        ? { connect: lists.connect, resource: lists.resource, base: lists.base, hash: origins?.hash ?? "", approved: false as const, approved_at: null }
        : null
    : origins && origins.approved && listed > 0
      ? origins
      : null;
  const hashKnown = Boolean(requested?.hash);
  const sources = libraryCspSources(props.origin, declared);
  const csp = liveHtmlDocumentCsp(blocked ? {} : (props.record.live?.csp ?? {}), {
    ...sources,
    needsEval: selected.some((library) => library.needsEval),
  });
  async function approve() {
    if (!requested || busy || !requested.hash) return;
    setBusy(true);
    setActionError(null);
    try {
      const result = await approveArtifactOrigins(
        props.ownerKey,
        props.artifactId,
        { origins_hash: requested.hash, version: props.version },
        props.projectRoot,
      );
      setOrigins(result.origins);
      setDismissed(false);
      setFrameEpoch((value) => value + 1);
      props.onOrigins?.(result.origins);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }
  async function revoke() {
    if (!requested || busy) return;
    setBusy(true);
    setActionError(null);
    try {
      const result = await revokeArtifactOrigins(props.ownerKey, props.artifactId, props.projectRoot, requested.hash);
      if (result.origins) {
        setOrigins(result.origins);
        setDismissed(false);
        setFrameEpoch((value) => value + 1);
        props.onOrigins?.(result.origins);
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }
  const showBanner = requested !== null && !requested.approved && !dismissed;
  const showApproved = requested !== null && requested.approved;
  return (
    <div className="flex flex-col gap-3">
      {showBanner && requested ? (
        <OriginBanner
          origins={requested}
          hashKnown={hashKnown}
          busy={busy}
          error={actionError}
          onApprove={() => void approve()}
          onKeepBlocked={() => {
            setDismissed(true);
            setActionError(null);
          }}
        />
      ) : null}
      {requested && !requested.approved && dismissed ? (
        <button
          type="button"
          className="h-8 w-fit rounded-lg border border-[var(--sf-hairline-strong)] px-3 text-[13px] text-[var(--sf-text-1)]"
          onClick={() => setDismissed(false)}
        >
          Review origins
        </button>
      ) : null}
      {showApproved && requested ? (
        <div data-testid="live-html-origin-approved" className="flex flex-wrap items-center gap-3 text-[13px] text-[var(--sf-text-2)]">
          <span>Origins approved (revoke)</span>
          <button
            type="button"
            className="h-8 rounded-lg border border-[var(--sf-hairline-strong)] px-3 text-[13px] text-[var(--sf-text-1)] disabled:opacity-50"
            disabled={busy}
            onClick={() => void revoke()}
          >
            Revoke
          </button>
          {actionError ? (
            <p role="alert" className="text-[13px] text-[var(--sf-fail)]">
              {actionError}
            </p>
          ) : null}
        </div>
      ) : null}
      {failed ? (
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
      ) : (
        <LiveHtmlSession
          key={`${attempt}:${frameEpoch}:${props.version}:${csp}:${props.html}`}
          {...props}
          csp={csp}
          onTimeout={() => setFailed(true)}
          onRestart={() => {
            setFailed(false);
            setAttempt((value) => value + 1);
          }}
        />
      )}
    </div>
  );
}

function OriginGroup({ label, values }: { label: string; values: readonly string[] }) {
  if (values.length === 0) return null;
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-[var(--sf-text-3)]">{label}</div>
      {values.map((origin) => (
        <div key={origin} className="sf-mono text-[13px] text-[var(--sf-text-1)]">
          {origin}
        </div>
      ))}
    </div>
  );
}

function OriginBanner(props: {
  origins: ArtifactOriginView;
  hashKnown: boolean;
  busy: boolean;
  error: string | null;
  onApprove: () => void;
  onKeepBlocked: () => void;
}) {
  return (
    <section
      role="region"
      aria-label="Origin approval"
      data-testid="live-html-origin-banner"
      className="rounded-lg border border-[var(--sf-hairline)] bg-[var(--sf-needs-bg)] px-4 py-3"
    >
      <p className="flex items-start gap-2 text-[13px] font-medium text-[var(--sf-text-1)]">
        <LuShieldAlert aria-hidden="true" className="mt-0.5 shrink-0 text-[var(--sf-needs)]" />
        This artifact asks to contact external servers. Nothing is allowed until you approve.
      </p>
      <p className="mt-2 text-[13px] text-[var(--sf-text-2)]">
        Approved origins can receive any data this artifact can read, including its bound data.
      </p>
      <div className="mt-3 flex flex-col gap-2">
        <OriginGroup label="Send and receive data (connect)" values={props.origins.connect} />
        <OriginGroup label="Load scripts, styles, images and fonts (resources)" values={props.origins.resource} />
        <OriginGroup label="Base URL" values={props.origins.base} />
      </div>
      <details className="mt-3">
        <summary className="cursor-pointer text-[13px] text-[var(--sf-text-2)]">Details</summary>
        {props.hashKnown ? <p className="sf-mono mt-1 text-[12px] text-[var(--sf-text-1)]">{props.origins.hash.slice(0, 8)}</p> : null}
        <p className="mt-1 text-[12px] text-[var(--sf-text-2)]">
          Tools cannot approve. The approve API needs the control token, and the CLI refuses inside a stage or agent session. A model with unrestricted shell access and the operator&apos;s home directory can still read the control token or the database and bypass that. Stages run with a curated environment, and a shell command can still reach those files.
        </p>
      </details>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          className="h-8 rounded-lg border border-[var(--sf-hairline-strong)] px-3 text-[13px] text-[var(--sf-text-1)] disabled:opacity-50"
          disabled={props.busy || !props.hashKnown}
          onClick={props.onApprove}
        >
          {props.hashKnown ? "Approve these origins" : "Reload to approve"}
        </button>
        <button
          type="button"
          className="h-8 rounded-lg border border-[var(--sf-hairline-strong)] px-3 text-[13px] text-[var(--sf-text-1)] disabled:opacity-50"
          disabled={props.busy}
          onClick={props.onKeepBlocked}
        >
          Keep blocked
        </button>
      </div>
      {props.error ? (
        <p role="alert" className="mt-2 text-[13px] text-[var(--sf-fail)]">
          {props.error}
        </p>
      ) : null}
    </section>
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
    const libraryRefs = (props.record.live?.libraries ?? []).map((library) => ({ name: library.name, version: library.version }));
    bridgeRef.current = createHostBridge({
      sandboxOrigin: props.origin,
      html: props.html,
      csp: props.csp,
      nonce,
      libraries: libraryRefs,
      allowEval: (props.record.live?.libraries ?? []).some((library) => library.allowEval === true),
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
