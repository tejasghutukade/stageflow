import { createElement, lazy, Suspense } from "react";
import { LIVE_VERSION_SNAPSHOT_NOTE } from "../../redesign/artifacts/artifactDetailModel";
import type { LiveQuery } from "../../redesign/artifacts/liveData/liveQuery";
import { StaticArtifactBody } from "../../redesign/artifacts/renderers/StaticPreview";
import { ChatStaticBody } from "../designStyles";
import { lookupFormatRenderer, registerFormatRenderer, type ArtifactFormatProps, type CardFormatProps, type FormatRenderer } from "./formatRegistry";

/** Loaded on demand so the live renderers stay out of the main bundles. */
const HtmlCardSandbox = lazy(() => import("./htmlCardFrame").then((mod) => ({ default: mod.HtmlCardSandbox })));

const LiveArtifactRenderer = lazy(() =>
  import("../../redesign/artifacts/live/LiveArtifactRenderer").then((mod) => ({ default: mod.LiveArtifactRenderer })),
);

const LiveHtmlFrame = lazy(() =>
  import("../../redesign/artifacts/liveHtml/LiveHtmlFrame").then((mod) => ({ default: mod.LiveHtmlFrame })),
);

/** A card has no bindings, so nothing should ask for data; answer any stray query with an error instead of a request. */
const noQuery: LiveQuery = async () => ({ status: 404, body: { code: "ui.card_display_only", error: "A card has no live data" } });

function Loading({ text }: { text: string }) {
  return <p className="text-[13px] text-[var(--sf-text-3)]">{text}</p>;
}

function SourceDetails({ summary, text }: { summary: string; text: string }) {
  return (
    <details className="mt-4">
      <summary className="cursor-pointer text-[13px] text-[var(--sf-text-2)]">{summary}</summary>
      <pre className="sf-mono mt-2 whitespace-pre-wrap text-[13px] text-[var(--sf-text-1)]">{text}</pre>
    </details>
  );
}

function StaticArtifact({ preview, imageUrl, title }: ArtifactFormatProps) {
  if (!preview) return <Loading text="Loading artifact…" />;
  return <StaticArtifactBody preview={preview} imageUrl={imageUrl} imageAlt={title} />;
}

const LIVE_DECLARATIVE: FormatRenderer = {
  card: ({ card, identity }) => (
    <Suspense fallback={<Loading text="Loading card…" />}>
      <LiveArtifactRenderer
        format={null}
        library={card.library ?? null}
        program={card.program}
        bindings={[]}
        snapshots={[]}
        status="ok"
        lastRefreshedAt={null}
        lastErrorCode={null}
        settled
        historical={false}
        ownerKey="card"
        artifactId={identity}
        query={noQuery}
      />
    </Suspense>
  ),
  artifact: ({ livePreview, program, showSourceDetails }) => (
    <div>
      {livePreview ? (
        <Suspense fallback={<Loading text="Loading live preview…" />}>
          <LiveArtifactRenderer {...livePreview} />
        </Suspense>
      ) : (
        <Loading text="Loading live preview…" />
      )}
      {showSourceDetails ? <SourceDetails summary="Program source" text={program ?? ""} /> : null}
    </div>
  ),
};

const LIVE_HTML: FormatRenderer = {
  card: ({ card }) => (
    <Suspense fallback={<Loading text="Loading card…" />}>
      <HtmlCardSandbox program={card.program} libraries={card.libraries ?? []} />
    </Suspense>
  ),
  artifact: ({ liveHtml, historicalSnapshots, showSourceDetails }) => (
    <div>
      {historicalSnapshots ? <p className="mb-3 text-[13px] text-[var(--sf-text-2)]">{LIVE_VERSION_SNAPSHOT_NOTE}</p> : null}
      {liveHtml ? (
        <Suspense fallback={<Loading text="Loading live HTML…" />}>
          <LiveHtmlFrame {...liveHtml} />
        </Suspense>
      ) : (
        <Loading text="Loading live HTML…" />
      )}
      {showSourceDetails ? <SourceDetails summary="HTML source" text={liveHtml?.html ?? ""} /> : null}
    </div>
  ),
};

const STATIC_MARKDOWN: FormatRenderer = {
  card: ({ card }) => <ChatStaticBody preview={{ mode: "markdown", text: card.program }} imageAlt={card.title} />,
  artifact: StaticArtifact,
};

let registered = false;

function ensureBuiltinFormats(): void {
  if (registered) return;
  registered = true;
  registerFormatRenderer("live.declarative", LIVE_DECLARATIVE);
  registerFormatRenderer("live.html", LIVE_HTML);
  registerFormatRenderer("static.markdown", STATIC_MARKDOWN);
}

/** A card's body. Card formats other than the registered ones render as declarative programs, as cards always have. */
export function renderCardFormat(props: CardFormatProps) {
  const render = formatRenderer(props.card.format)?.card ?? LIVE_DECLARATIVE.card!;
  return createElement(render, props);
}

/** The renderer for a kind, with the built-in kinds registered on first use. */
export function formatRenderer(kind: string): FormatRenderer | undefined {
  ensureBuiltinFormats();
  return lookupFormatRenderer(kind);
}

/** Kinds without their own artifact renderer (static files) show the static preview. */
export function renderArtifactFormat(kind: string, props: ArtifactFormatProps) {
  return createElement(formatRenderer(kind)?.artifact ?? StaticArtifact, props);
}
