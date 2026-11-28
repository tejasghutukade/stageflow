import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { ArtifactSnapshot } from "../../api/artifacts";
import type { VisitorArtifactPayload } from "../api";
import type { LiveQuery } from "../../redesign/artifacts/liveData/liveQuery";
import { previewFromContent } from "../../redesign/artifacts/renderers/previewModel";
import { ExplanationCard } from "../../redesign/artifacts/renderers/StaticPreview";
import { ChatStaticBody } from "../designStyles";
import type { VisitorArtifactLoader } from "../visitorArtifactContext";

const HtmlCardSandbox = lazy(() => import("./htmlCardFrame").then((mod) => ({ default: mod.HtmlCardSandbox })));

const LiveArtifactRenderer = lazy(() =>
  import("../../redesign/artifacts/live/LiveArtifactRenderer").then((mod) => ({ default: mod.LiveArtifactRenderer })),
);

/** Bindings are not re-run for a visitor. A stored snapshot is the only data. */
const STORED_SNAPSHOT: LiveQuery = async () => ({
  status: 404,
  body: { code: "web_chat.unavailable", error: "This view shows the saved snapshot." },
});

function snapshotsOf(view: VisitorArtifactPayload): ArtifactSnapshot[] {
  return (view.snapshots ?? []).map((item) => ({
    binding_id: item.binding_id,
    args_hash: "",
    value: item.value,
    fetched_at: item.fetched_at,
    duration_ms: 0,
    status: item.status,
    error_code: null,
  }));
}

function VisitorArtifactBody({ view }: { view: VisitorArtifactPayload }) {
  if (view.kind === "live.html") {
    if (!view.text) return <ExplanationCard testId="visitor-artifact-unavailable" title="This artifact is unavailable" body="It could not be shown." />;
    return (
      <Suspense fallback={<p className="text-[13px] text-[var(--sf-text-3)]">Loading…</p>}>
        <HtmlCardSandbox program={view.text} libraries={view.libraries ?? []} />
      </Suspense>
    );
  }
  if (view.kind === "live.declarative") {
    if (!view.text) return <ExplanationCard testId="visitor-artifact-unavailable" title="This artifact is unavailable" body="It could not be shown." />;
    const bindings = view.bindings ?? [];
    return (
      <Suspense fallback={<p className="text-[13px] text-[var(--sf-text-3)]">Loading…</p>}>
        <LiveArtifactRenderer
          format={view.format ?? null}
          library={view.library ?? null}
          program={view.text}
          bindings={bindings}
          snapshots={snapshotsOf(view)}
          status="ok"
          lastRefreshedAt={null}
          lastErrorCode={null}
          settled
          historical={bindings.length > 0}
          ownerKey="chat"
          artifactId={`v${view.version}`}
          query={STORED_SNAPSHOT}
        />
      </Suspense>
    );
  }
  const preview = previewFromContent({
    record: {
      kind: view.kind,
      title: view.title,
      content_type: view.contentType ?? null,
      status: "available",
      expired_reason: null,
    },
    text: view.text,
    binary: view.text === null,
  });
  return <ChatStaticBody preview={preview} imageAlt={view.title} />;
}

export function VisitorArtifact({
  artifactKey,
  version,
  title,
  load,
}: {
  artifactKey: string;
  version?: number;
  title: string;
  load: VisitorArtifactLoader;
}) {
  const loadRef = useRef(load);
  loadRef.current = load;
  const [state, setState] = useState<{ phase: "loading" } | { phase: "ready"; view: VisitorArtifactPayload } | { phase: "error" }>({ phase: "loading" });
  useEffect(() => {
    let cancelled = false;
    setState({ phase: "loading" });
    void loadRef.current(artifactKey, version).then(
      (view) => {
        if (!cancelled) setState({ phase: "ready", view });
      },
      () => {
        if (!cancelled) setState({ phase: "error" });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [artifactKey, version]);
  return (
    <div className="min-w-0" data-testid="visitor-artifact">
      <div className="mb-1 text-[13px] font-medium text-[var(--sf-text-1)]">{title}</div>
      {state.phase === "loading" ? <p className="text-[13px] text-[var(--sf-text-3)]">Loading artifact…</p> : null}
      {state.phase === "error" ? (
        <ExplanationCard testId="visitor-artifact-unavailable" title="This artifact is unavailable" body="It was deleted or it has expired." />
      ) : null}
      {state.phase === "ready" ? <VisitorArtifactBody view={state.view} /> : null}
    </div>
  );
}
