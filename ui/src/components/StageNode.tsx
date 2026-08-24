import { ringGlyph, type RingStatus } from "../status/runStatus";

export type StageStatus = RingStatus;

export type StageNodeProps = {
  id: string;
  label: string;
  status: StageStatus;
  index?: number;
  meta?: string;
  selected?: boolean;
  onClick?: () => void;
};

export function StageNode({
  label,
  status,
  index,
  meta,
  selected,
  onClick,
}: StageNodeProps) {
  const glyph = ringGlyph(status) || (index != null ? String(index + 1) : "");

  return (
    <button
      type="button"
      className="node"
      data-s={status}
      data-selected={selected ? "true" : undefined}
      onClick={onClick}
      aria-disabled={!onClick}
      style={{ cursor: onClick ? "pointer" : "default" }}
    >
      <span className="node__ring" aria-hidden="true">{glyph}</span>
      <span className="node__name">{label}</span>
      {meta ? <span className="node__meta">{meta}</span> : null}
    </button>
  );
}
