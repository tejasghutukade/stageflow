import { renderUiPart } from "../../chat/parts/registry";
import type { UiPartCard } from "../../../../src/artifacts/uiPartCard.ts";

export function GuidePresentCard({ part }: { part: UiPartCard }) {
  return <div className="min-w-0">{renderUiPart(part)}</div>;
}