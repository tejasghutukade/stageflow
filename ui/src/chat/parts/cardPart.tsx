import { useMemo, useState, type CSSProperties } from "react";
import { parseUiPartCard, UI_PART_KIND_CARD, type UiPartCard } from "../../../../src/artifacts/uiPartCard.ts";
import { ARTIFACT_VIEW_INLINE_COLLAPSED_MAX_PX } from "../../redesign/artifacts/ArtifactView";
import { renderCardFormat } from "./formats";
import { lookupUiPart, registerUiPart, type UiPartRendererProps } from "./registry";

function cardIdentity(part: UiPartCard): string {
  let hash = 0;
  for (let index = 0; index < part.program.length; index += 1) hash = (hash * 31 + part.program.charCodeAt(index)) | 0;
  return `card-${(hash >>> 0).toString(36)}-${part.program.length}`;
}

function CardBody({ part }: { part: UiPartCard }) {
  const identity = useMemo(() => cardIdentity(part), [part]);
  return renderCardFormat({ card: part, identity });
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
