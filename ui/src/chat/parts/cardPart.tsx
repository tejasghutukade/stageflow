import { lazy, Suspense, useMemo, useState, type CSSProperties } from "react";
import { parseUiPartCard, UI_PART_KIND_CARD, type UiPartCard } from "../../../../src/artifacts/uiPartCard.ts";
import { useChatSandboxOrigins } from "../sandboxContext";
import { ARTIFACT_VIEW_INLINE_COLLAPSED_MAX_PX } from "../../redesign/artifacts/ArtifactView";
import type { LiveQuery } from "../../redesign/artifacts/liveData/liveQuery";
import { ChatStaticBody } from "../designStyles";
import { lookupUiPart, registerUiPart, type UiPartRendererProps } from "./registry";

/** Loaded on demand so the live HTML code stays out of the chat page's main bundle. */
const HtmlCardSandbox = lazy(() => import("./htmlCardFrame").then((mod) => ({ default: mod.HtmlCardSandbox })));

const LiveArtifactRenderer = lazy(() =>
  import("../../redesign/artifacts/live/LiveArtifactRenderer").then((mod) => ({ default: mod.LiveArtifactRenderer })),
);

/** A card has no bindings, so nothing should ask for data; answer any stray query with an error instead of a request. */
const noQuery: LiveQuery = async () => ({ status: 404, body: { code: "ui.card_display_only", error: "A card has no live data" } });

function cardIdentity(part: UiPartCard): string {
  let hash = 0;
  for (let index = 0; index < part.program.length; index += 1) hash = (hash * 31 + part.program.charCodeAt(index)) | 0;
  return `card-${(hash >>> 0).toString(36)}-${part.program.length}`;
}

function CardBody({ part }: { part: UiPartCard }) {
  const identity = useMemo(() => cardIdentity(part), [part]);
  const { sandboxOrigins } = useChatSandboxOrigins();
  if (part.format === "static.markdown") {
    return <ChatStaticBody preview={{ mode: "markdown", text: part.program }} imageAlt={part.title} />;
  }
  if (part.format === "live.html") {
    return (
      <Suspense fallback={<p className="text-[13px] text-[var(--sf-text-3)]">Loading card…</p>}>
        <HtmlCardSandbox program={part.program} libraries={part.libraries ?? []} sandboxOrigins={sandboxOrigins} />
      </Suspense>
    );
  }
  return (
    <Suspense fallback={<p className="text-[13px] text-[var(--sf-text-3)]">Loading card…</p>}>
      <LiveArtifactRenderer
        format={null}
        library={part.library ?? null}
        program={part.program}
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
  );
}

function CardPart({ part, context }: UiPartRendererProps) {
  const parsed = parseUiPartCard(part);
  const [expanded, setExpanded] = useState(false);
  if (!parsed.ok) return lookupUiPart("")({ part, context });
  const card = parsed.part;
  const style = expanded ? undefined : ({ "--sf-card-max": `${ARTIFACT_VIEW_INLINE_COLLAPSED_MAX_PX}px` } as CSSProperties);
  return (
    <div className="min-w-0" data-testid="ui-card">
      <div className="mb-1 text-[13px] font-medium text-[var(--sf-text-1)]">{card.title}</div>
      <div
        className={`min-w-0 overflow-hidden rounded-lg border border-[var(--sf-hairline)] bg-[var(--sf-panel)] ${expanded ? "" : "max-h-[var(--sf-card-max)]"}`}
        style={style}
      >
        <div className="min-w-0 p-3">
          <CardBody part={card} />
        </div>
      </div>
      <div className="mt-1 flex justify-end">
        <button
          type="button"
          className="text-[12px] text-[var(--sf-text-2)] underline decoration-[var(--sf-hairline)]"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "Collapse" : "Expand"}
        </button>
      </div>
    </div>
  );
}

let registered = false;

export function ensureCardPartRegistered(): void {
  if (registered) return;
  registerUiPart(UI_PART_KIND_CARD, CardPart);
  registered = true;
}
