import {
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { StageGateKind, StageSnapshot } from "../api";
import {
  SPATIAL_NODE_H,
  type SpatialNodeBox,
  type SpatialTrackLayout,
} from "../track/layoutPipelineTrack";
import {
  abandonedDisplayCopy,
  isAbandonedDisplay,
  statusCopy,
} from "../status/runStatus";
import { canAbandon, canRetry, isStageActionBusy } from "../stageAction";
import { AttemptCountBadge } from "./AttemptCountBadge";
import type { TrackDetailRow } from "./TrackDetailList";

export const PAN_CLICK_THRESHOLD_PX = 4;
export const SPATIAL_ZOOM_MIN = 0.25;
export const SPATIAL_ZOOM_MAX = 1.8;
export const SPATIAL_FIT_PAD = 24;
export const SPATIAL_FIT_TOOL_INSET = 56;

export type SpatialBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export function isPanGesture(
  dx: number,
  dy: number,
  threshold = PAN_CLICK_THRESHOLD_PX,
): boolean {
  return Math.hypot(dx, dy) > threshold;
}

export function spatialFitBounds(
  boxes: Array<Pick<SpatialNodeBox, "x" | "y" | "width" | "height">>,
  pad = SPATIAL_FIT_PAD,
): SpatialBox {
  if (boxes.length === 0) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const box of boxes) {
    minX = Math.min(minX, box.x);
    minY = Math.min(minY, box.y);
    maxX = Math.max(maxX, box.x + box.width);
    maxY = Math.max(maxY, box.y + box.height);
  }
  return {
    x: minX - pad,
    y: minY - pad,
    width: maxX - minX + pad * 2,
    height: maxY - minY + pad * 2,
  };
}

export function fitTransform(
  bounds: SpatialBox,
  viewport: { width: number; height: number },
): { panX: number; panY: number; zoom: number } {
  if (bounds.width <= 0 || bounds.height <= 0 || viewport.width <= 0 || viewport.height <= 0) {
    return { panX: 0, panY: 0, zoom: 1 };
  }
  const usableW = viewport.width - SPATIAL_FIT_TOOL_INSET;
  const usableH = viewport.height - SPATIAL_FIT_TOOL_INSET;
  if (usableW <= 0 || usableH <= 0) {
    return { panX: 0, panY: 0, zoom: 1 };
  }
  const z = Math.max(
    SPATIAL_ZOOM_MIN,
    Math.min(
      1.1,
      SPATIAL_ZOOM_MAX,
      usableW / bounds.width,
      usableH / bounds.height,
    ),
  );
  return {
    zoom: z,
    panX: SPATIAL_FIT_TOOL_INSET + (usableW - bounds.width * z) / 2 - bounds.x * z,
    panY: SPATIAL_FIT_TOOL_INSET + (usableH - bounds.height * z) / 2 - bounds.y * z,
  };
}

export function shouldRefitOnViewportChange(
  alreadyFitted: boolean,
  userMoved: boolean,
): boolean {
  return alreadyFitted && !userMoved;
}

export function spatialNodeKicker(kicker: string, title: string): string | null {
  return kicker === title ? null : kicker;
}

export function selectableSpatialStageIds(stages: StageSnapshot[]): string[] {
  return stages.filter((s) => s.status !== "pending").map((s) => s.stage_id);
}

export function envelopeEdgeEnabled(
  stages: StageSnapshot[],
  fromStageId: string,
): boolean {
  return Boolean(stages.find((s) => s.stage_id === fromStageId)?.envelope);
}

export function spatialNodeAction(
  status: StageSnapshot["status"],
  abandoned: boolean,
): "retry" | "abandon" | null {
  if (status === "waiting_for_input" || status === "pending" || status === "skipped") {
    return null;
  }
  if (status === "running") return "abandon";
  if (status === "failed" || abandoned) return "retry";
  return null;
}

function gateLabel(kind: StageGateKind): string {
  switch (kind) {
    case "free_text":
      return "free text";
    case "confirm":
      return "confirm";
    case "multi_question":
      return "multi-question";
    case "artifact_backed":
      return "artifact";
  }
}

function cubicEdgePath(x1: number, y1: number, x2: number, y2: number): string {
  const bend = Math.max(48, (x2 - x1) / 2);
  return `M${x1} ${y1} C${x1 + bend} ${y1} ${x2 - bend} ${y2} ${x2} ${y2}`;
}

function nodeChromeStatus(
  status: StageSnapshot["status"],
  abandoned: boolean,
): string {
  if (abandoned) return "abandoned";
  return status;
}

export type SpatialRunMapProps = {
  layout: SpatialTrackLayout;
  stages: StageSnapshot[];
  detailListRows: TrackDetailRow[];
  selectedStageId: string | null;
  onSelectStage: (stageId: string) => void;
  onDeselect: () => void;
  retryingStageIds?: ReadonlySet<string>;
  onRetryStage?: (stageId: string) => void;
  abandoningStageId?: string | null;
  onAbandonStage?: (stageId: string) => void;
  runId?: string;
  showHint?: boolean;
};

export function SpatialRunMap({
  layout,
  stages,
  detailListRows,
  selectedStageId,
  onSelectStage,
  onDeselect,
  retryingStageIds,
  onRetryStage,
  abandoningStageId = null,
  onAbandonStage,
  runId,
  showHint,
}: SpatialRunMapProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const fittedRef = useRef(false);
  const userMovedRef = useRef(false);
  const lastFitViewportRef = useRef({ width: 0, height: 0 });
  const gestureRef = useRef<{
    id: number;
    x: number;
    y: number;
    panX: number;
    panY: number;
  } | null>(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [dragging, setDragging] = useState(false);

  const snapshots = new Map(stages.map((s) => [s.stage_id, s]));
  const rows = new Map(detailListRows.map((r) => [r.stageId, r]));
  const retrying = retryingStageIds ?? new Set<string>();

  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      setViewport({ width: rect.width, height: rect.height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    fittedRef.current = false;
    userMovedRef.current = false;
    lastFitViewportRef.current = { width: 0, height: 0 };
  }, [runId]);

  useLayoutEffect(() => {
    if (layout.nodes.length === 0 || viewport.width === 0 || viewport.height === 0) return;
    if (!fittedRef.current) {
      const next = fitTransform(spatialFitBounds(layout.nodes), viewport);
      setPan({ x: next.panX, y: next.panY });
      setZoom(next.zoom);
      fittedRef.current = true;
      lastFitViewportRef.current = { width: viewport.width, height: viewport.height };
      return;
    }
    const viewportChanged =
      lastFitViewportRef.current.width !== viewport.width ||
      lastFitViewportRef.current.height !== viewport.height;
    if (!viewportChanged) return;
    lastFitViewportRef.current = { width: viewport.width, height: viewport.height };
    if (!shouldRefitOnViewportChange(true, userMovedRef.current)) return;
    const next = fitTransform(spatialFitBounds(layout.nodes), viewport);
    setPan({ x: next.panX, y: next.panY });
    setZoom(next.zoom);
  }, [layout.nodes, viewport.height, viewport.width]);

  const applyZoom = (factor: number, origin?: { x: number; y: number }) => {
    const point = origin ?? { x: viewport.width / 2, y: viewport.height / 2 };
    const next = Math.max(SPATIAL_ZOOM_MIN, Math.min(SPATIAL_ZOOM_MAX, zoom * factor));
    const wx = (point.x - pan.x) / zoom;
    const wy = (point.y - pan.y) / zoom;
    userMovedRef.current = true;
    setPan({ x: point.x - wx * next, y: point.y - wy * next });
    setZoom(next);
  };

  const fitRun = () => {
    const el = stageRef.current;
    if (!el || layout.nodes.length === 0) return;
    const rect = el.getBoundingClientRect();
    const next = fitTransform(spatialFitBounds(layout.nodes), {
      width: rect.width,
      height: rect.height,
    });
    setPan({ x: next.panX, y: next.panY });
    setZoom(next.zoom);
    userMovedRef.current = false;
    fittedRef.current = true;
    lastFitViewportRef.current = { width: rect.width, height: rect.height };
  };

  const onCanvasPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const target = event.target as Element;
    if (target.closest(".gnode")) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
    gestureRef.current = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      panX: pan.x,
      panY: pan.y,
    };
  };

  const onCanvasPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.id !== event.pointerId) return;
    const dx = event.clientX - gesture.x;
    const dy = event.clientY - gesture.y;
    if (isPanGesture(dx, dy)) userMovedRef.current = true;
    setPan({ x: gesture.panX + dx, y: gesture.panY + dy });
  };

  const endCanvasPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.id !== event.pointerId) return;
    const dx = event.clientX - gesture.x;
    const dy = event.clientY - gesture.y;
    gestureRef.current = null;
    setDragging(false);
    if (!isPanGesture(dx, dy)) onDeselect();
  };

  return (
    <div className="graph-view">
      <svg className="graph-grid" aria-hidden="true" width="100%" height="100%">
        <defs>
          <pattern id="spatial-dots" width="24" height="24" patternUnits="userSpaceOnUse">
            <circle cx="1" cy="1" r="1" fill="var(--color-border)" />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#spatial-dots)" />
      </svg>
      <div
        ref={stageRef}
        className={dragging ? "graph-stage dragging" : "graph-stage"}
        onPointerDown={onCanvasPointerDown}
        onPointerMove={onCanvasPointerMove}
        onPointerUp={endCanvasPointer}
        onPointerCancel={endCanvasPointer}
        onWheel={(event) => {
          event.preventDefault();
          const rect = event.currentTarget.getBoundingClientRect();
          if (event.metaKey || event.ctrlKey) {
            applyZoom(event.deltaY < 0 ? 1.08 : 0.92, {
              x: event.clientX - rect.left,
              y: event.clientY - rect.top,
            });
            return;
          }
          userMovedRef.current = true;
          setPan((current) => ({
            x: current.x - event.deltaX,
            y: current.y - event.deltaY,
          }));
        }}
      >
        <svg className="graph-svg" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <marker id="spatial-arrow" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">
              <path d="M0,0 L7,3 L0,6 Z" fill="var(--color-text-disabled)" />
            </marker>
            <marker id="spatial-arrow-active" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">
              <path d="M0,0 L7,3 L0,6 Z" fill="var(--color-accent)" />
            </marker>
          </defs>
          <g
            className="world"
            transform={`translate(${pan.x} ${pan.y}) scale(${zoom})`}
          >
            {layout.edges.map((edge) => {
              const from = layout.nodes.find((n) => n.stageId === edge.from);
              const to = layout.nodes.find((n) => n.stageId === edge.to);
              if (!from || !to) return null;
              const fromH = from.height;
              const toH = to.height;
              const x1 = from.x + from.width;
              const y1 = from.y + fromH / 2;
              const x2 = to.x;
              const y2 = to.y + toH / 2;
              const hasEnvelope = envelopeEdgeEnabled(stages, edge.from);
              return (
                <g key={`${edge.from}->${edge.to}`}>
                  <path
                    className={hasEnvelope ? "edge handoff" : "edge"}
                    d={cubicEdgePath(x1, y1, x2, y2)}
                    markerEnd={
                      hasEnvelope ? "url(#spatial-arrow-active)" : "url(#spatial-arrow)"
                    }
                  />
                </g>
              );
            })}
            {layout.nodes.map((node) => {
              const snap = snapshots.get(node.stageId);
              const row = rows.get(node.stageId);
              const status = snap?.status ?? row?.status ?? "pending";
              const abandoned = snap ? isAbandonedDisplay(snap.events) : false;
              return (
                <SpatialNode
                  key={node.stageId}
                  node={node}
                  status={status}
                  abandoned={abandoned}
                  label={row?.label ?? node.stageId}
                  row={row}
                  selected={selectedStageId === node.stageId}
                  busy={isStageActionBusy(
                    { retryingStageIds: retrying, abandoningStageId },
                    node.stageId,
                  )}
                  retrying={retrying.has(node.stageId)}
                  abandoning={abandoningStageId === node.stageId}
                  onSelectStage={onSelectStage}
                  onRetryStage={onRetryStage}
                  onAbandonStage={onAbandonStage}
                />
              );
            })}
          </g>
        </svg>
      </div>
      <div className="canvas-tools">
        <button
          type="button"
          className="icon"
          title="Zoom out"
          aria-label="Zoom out"
          onClick={() => applyZoom(0.87)}
        >
          −
        </button>
        <span className="zoom" aria-live="polite">{Math.round(zoom * 100)}%</span>
        <button
          type="button"
          className="icon"
          title="Zoom in"
          aria-label="Zoom in"
          onClick={() => applyZoom(1.15)}
        >
          +
        </button>
        <span className="divider" />
        <button type="button" className="icon fit-btn" onClick={fitRun}>
          Fit run
        </button>
      </div>
      {showHint ? (
        <div className="canvas-hint">Stages become selectable when they start.</div>
      ) : null}
    </div>
  );
}

function SpatialNode({
  node,
  status,
  abandoned,
  label,
  row,
  selected,
  busy,
  retrying,
  abandoning,
  onSelectStage,
  onRetryStage,
  onAbandonStage,
}: {
  node: SpatialNodeBox;
  status: StageSnapshot["status"];
  abandoned: boolean;
  label: string;
  row: TrackDetailRow | undefined;
  selected: boolean;
  busy: boolean;
  retrying: boolean;
  abandoning: boolean;
  onSelectStage: (stageId: string) => void;
  onRetryStage?: (stageId: string) => void;
  onAbandonStage?: (stageId: string) => void;
}) {
  const pending = status === "pending";
  const selectable = !pending;
  const action = spatialNodeAction(status, abandoned);
  const showRetry = action === "retry" && canRetry(status) && onRetryStage;
  const showAbandon = action === "abandon" && canAbandon(status) && onAbandonStage;
  const chrome = nodeChromeStatus(status, abandoned);
  const statusLabel = abandoned ? abandonedDisplayCopy() : statusCopy(status);
  const kicker = spatialNodeKicker(label, label);
  const metaParts = [statusLabel];
  if (row?.readinessLine && status === "pending") metaParts.push(row.readinessLine);
  if (status === "waiting_for_input") {
    if (row?.gateKinds?.length) metaParts.push(row.gateKinds.map(gateLabel).join(" · "));
    if (row?.promptSummary) metaParts.push(row.promptSummary);
  } else if (row?.meta) {
    metaParts.push(row.meta);
  }

  const select = () => {
    if (!selectable) return;
    onSelectStage(node.stageId);
  };

  return (
    <g
      className={`gnode ${chrome}${selected ? " selected" : ""}`}
      data-id={node.stageId}
      data-waiting={row?.isWaitingAttention ? "true" : undefined}
      transform={`translate(${node.x},${node.y})`}
    >
      <rect className="node-box" x={0} y={0} width={node.width} height={SPATIAL_NODE_H} rx={12} ry={12} />
      <circle className="port" cx={-4} cy={SPATIAL_NODE_H / 2} r={4} />
      <circle className="port" cx={node.width + 4} cy={SPATIAL_NODE_H / 2} r={4} />
      {selectable ? (
        <foreignObject x={0} y={0} width={node.width} height={SPATIAL_NODE_H}>
          <button
            type="button"
            className="gnode__hit"
            onClick={select}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                select();
              }
            }}
          >
            {kicker ? <span className="gnode__kicker">{kicker}</span> : null}
            <span className="gnode__title">
              {label}
              <AttemptCountBadge count={row?.attemptCount} />
            </span>
            <span className="gnode__meta">{metaParts.join(" · ")}</span>
          </button>
        </foreignObject>
      ) : (
        <g className="gnode__static">
          {kicker ? (
            <text className="kicker" x={16} y={22}>
              {kicker}
            </text>
          ) : null}
          <text className="node-title" x={16} y={kicker ? 44 : 32}>
            {label}
          </text>
          <text className="node-meta" x={16} y={66}>
            {metaParts.join(" · ")}
          </text>
        </g>
      )}
      <NodeStatusColumn
        status={status}
        abandoned={abandoned}
        cx={node.width - 26}
        cy={26}
        showRetry={Boolean(showRetry)}
        showAbandon={Boolean(showAbandon)}
        busy={busy}
        retryLabel={retrying ? "Retrying…" : "Retry stage"}
        abandonLabel={abandoning ? "Abandoning…" : "Abandon stage"}
        onRetry={
          showRetry
            ? () => {
                onRetryStage?.(node.stageId);
              }
            : undefined
        }
        onAbandon={
          showAbandon
            ? () => {
                onAbandonStage?.(node.stageId);
              }
            : undefined
        }
      />
    </g>
  );
}

function NodeStatusAction({
  kind,
  cx,
  cy,
  busy,
  label,
  onActivate,
}: {
  kind: "retry" | "abandon";
  cx: number;
  cy: number;
  busy: boolean;
  label: string;
  onActivate?: () => void;
}) {
  const onClick = (event: MouseEvent) => {
    if (busy) return;
    event.stopPropagation();
    onActivate?.();
  };
  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (busy) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    event.stopPropagation();
    onActivate?.();
  };
  return (
    <g
      className={`node-action-btn node-${kind}${busy ? " is-busy" : ""}`}
      role="button"
      tabIndex={busy ? -1 : 0}
      aria-label={label}
      aria-disabled={busy || undefined}
      onClick={onClick}
      onKeyDown={onKeyDown}
    >
      <title>{label}</title>
      <circle className="action-bg" cx={cx} cy={cy} r={11} />
      {kind === "retry" ? (
        <path
          className="action-icon"
          d={[
            `M${cx - 3.2} ${cy - 2.2}`,
            `A4.2 4.2 0 1 0 ${cx + 0.2} ${cy - 4}`,
            `M${cx + 0.2} ${cy - 7.2}`,
            `L${cx + 0.2} ${cy - 3.6}`,
            `L${cx - 3.4} ${cy - 3.6}`,
          ].join(" ")}
        />
      ) : (
        <rect
          className="action-icon"
          x={cx - 3.5}
          y={cy - 3.5}
          width={7}
          height={7}
          rx={1.25}
        />
      )}
    </g>
  );
}

function NodeStatusColumn({
  status,
  abandoned,
  cx,
  cy,
  showRetry,
  showAbandon,
  busy,
  retryLabel,
  abandonLabel,
  onRetry,
  onAbandon,
}: {
  status: StageSnapshot["status"];
  abandoned: boolean;
  cx: number;
  cy: number;
  showRetry: boolean;
  showAbandon: boolean;
  busy: boolean;
  retryLabel: string;
  abandonLabel: string;
  onRetry?: () => void;
  onAbandon?: () => void;
}) {
  const actionY = cy + 28;
  return (
    <g className="node-status">
      {status === "succeeded" ? (
        <>
          <circle cx={cx} cy={cy} r={11} fill="var(--color-success)" />
          <path
            d={`M${cx - 4} ${cy} l3 3 l6-7`}
            fill="none"
            stroke="var(--color-background-surface)"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      ) : null}
      {status === "running" ? (
        <>
          <circle
            className="node-spin"
            cx={cx}
            cy={cy}
            r={11}
            fill="none"
            stroke="var(--color-border)"
            strokeWidth={2}
          />
          <circle
            className="node-spin"
            cx={cx}
            cy={cy}
            r={11}
            fill="none"
            stroke="var(--color-accent)"
            strokeWidth={2.25}
            strokeLinecap="round"
            strokeDasharray="18 52"
          />
        </>
      ) : null}
      {status === "waiting_for_input" ? (
        <>
          <circle
            cx={cx}
            cy={cy}
            r={10}
            fill="none"
            stroke="var(--color-warning)"
            strokeWidth={2}
            strokeDasharray="4 3"
          />
          <text
            x={cx}
            y={cy + 4}
            textAnchor="middle"
            fill="var(--color-warning)"
            fontSize={11}
            fontWeight={700}
          >
            !
          </text>
        </>
      ) : null}
      {status === "failed" && !abandoned ? (
        <>
          <circle cx={cx} cy={cy} r={11} fill="var(--color-error)" />
          <text
            x={cx}
            y={cy + 4}
            textAnchor="middle"
            fill="var(--color-background-surface)"
            fontSize={12}
            fontWeight={700}
          >
            !
          </text>
        </>
      ) : null}
      {abandoned ? (
        <>
          <circle cx={cx} cy={cy} r={11} fill="var(--color-error)" />
          <rect
            x={cx - 5}
            y={cy - 1.5}
            width={10}
            height={3}
            rx={1}
            fill="var(--color-background-surface)"
          />
        </>
      ) : null}
      {status === "pending" || status === "skipped" ? (
        <circle
          cx={cx}
          cy={cy}
          r={10}
          fill="none"
          stroke="var(--color-text-disabled)"
          strokeWidth={1.5}
        />
      ) : null}
      {showRetry ? (
        <NodeStatusAction
          kind="retry"
          cx={cx}
          cy={actionY}
          busy={busy}
          label={retryLabel}
          onActivate={onRetry}
        />
      ) : null}
      {showAbandon ? (
        <NodeStatusAction
          kind="abandon"
          cx={cx}
          cy={actionY}
          busy={busy}
          label={abandonLabel}
          onActivate={onAbandon}
        />
      ) : null}
    </g>
  );
}
