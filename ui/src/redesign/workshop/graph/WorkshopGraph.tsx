import { Fragment, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { DraftPackagePayload, ValidationFinding } from "../../../api";
import { WorkshopCanvasToolbar } from "./WorkshopCanvasToolbar";
import { WorkshopEmptyCanvas } from "./WorkshopEmptyCanvas";
import { WorkshopGraphNodeCard } from "./WorkshopGraphNodeCard";
import {
  DEFAULT_GRAPH_VIEW,
  GRAPH_ZOOM_MAX,
  GRAPH_ZOOM_MIN,
  fitGraphView,
  stepZoom,
} from "./graphViewport";
import type { GraphView } from "./graphViewport";
import { buildWorkshopGraphModel } from "./workshopGraphModel";
import type { WorkshopGraphConnector, WorkshopGraphNode, WorkshopGraphRow } from "./workshopGraphModel";

export type WorkshopGraphProps = {
  draft: DraftPackagePayload;
  baseline: DraftPackagePayload | null;
  selectedStageId: string | null;
  findings: ValidationFinding[];
  onSelectStage: (id: string | null) => void;
  onAddStage: () => void;
  defaultModel?: string | null;
};

type DragState = {
  pointerId: number;
  startX: number;
  startY: number;
  panX: number;
  panY: number;
  moved: boolean;
};

function ChangeLegend() {
  const items = [
    { label: "new", swatch: "bg-[#6ca6ff24] border-[#6ca6ffbf]" },
    { label: "edited", swatch: "border-dashed border-[#6ca6ffbf]" },
    { label: "unchanged", swatch: "bg-[#131418] border-[#ffffff1f]" },
  ];
  return (
    <div className="absolute left-3 top-3 z-10 flex h-6 items-center gap-2.5 rounded-md border border-[#ffffff12] bg-[#0c0d0f] px-2">
      {items.map((item) => (
        <span key={item.label} className="flex items-center gap-[5px]">
          <span className={`block size-2.5 rounded-[3px] border ${item.swatch}`} />
          <span className="whitespace-nowrap font-sans text-[11px] text-[#a7aab2]">{item.label}</span>
        </span>
      ))}
    </div>
  );
}

function GraphConnector({ connector }: { connector: WorkshopGraphConnector }) {
  return (
    <div
      className="relative shrink-0"
      style={{ width: connector.width, height: connector.height }}
      data-connector={connector.kind}
    >
      {connector.segments.map((segment, index) => (
        <div
          key={index}
          className={`absolute ${segment.changed ? "bg-[#6ca6ff8c]" : "bg-[#ffffff33]"}`}
          style={{ left: segment.x, top: segment.y, width: segment.width, height: segment.height }}
        />
      ))}
    </div>
  );
}

function GraphRow({
  row,
  width,
  nodes,
  selectedStageId,
  onSelect,
}: {
  row: WorkshopGraphRow;
  width: number;
  nodes: Map<string, WorkshopGraphNode>;
  selectedStageId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="flex shrink-0" style={{ width }}>
      <div className="flex items-start gap-4" style={{ marginLeft: row.offset, width: row.width }}>
        {row.items.map((item) => {
          if (item.kind === "pass") {
            return (
              <div key={item.key} className="flex shrink-0 justify-center self-stretch" style={{ width: item.width }}>
                <div className={`w-px ${item.changed ? "bg-[#6ca6ff8c]" : "bg-[#ffffff33]"}`} />
              </div>
            );
          }
          const node = nodes.get(item.id);
          if (!node) return null;
          return (
            <WorkshopGraphNodeCard
              key={item.id}
              node={node}
              selected={node.id === selectedStageId}
              onSelect={onSelect}
            />
          );
        })}
      </div>
    </div>
  );
}

export function WorkshopGraph({
  draft,
  baseline,
  selectedStageId,
  findings,
  onSelectStage,
  onAddStage,
  defaultModel = null,
}: WorkshopGraphProps) {
  const model = useMemo(
    () => buildWorkshopGraphModel(draft, { baseline, findings, defaultModel }),
    [draft, baseline, findings, defaultModel],
  );
  const nodesById = useMemo(
    () => new Map(model.nodes.map((node) => [node.id, node])),
    [model.nodes],
  );
  const [view, setView] = useState<GraphView>(DEFAULT_GRAPH_VIEW);
  const [dragging, setDragging] = useState(false);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const empty = model.nodes.length === 0;

  const fit = () => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;
    setView(
      fitGraphView(
        { width: content.offsetWidth, height: content.offsetHeight },
        { width: viewport.clientWidth, height: viewport.clientHeight },
      ),
    );
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    if ((event.target as HTMLElement).closest("[data-graph-node]")) return;
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      panX: view.panX,
      panY: view.panY,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 3) return;
    if (!drag.moved) {
      drag.moved = true;
      setDragging(true);
    }
    setView((current) => ({ ...current, panX: drag.panX + dx, panY: drag.panY + dy }));
  };

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (!drag.moved && !cancelled) onSelectStage(null);
  };

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col bg-[#0c0d0f]">
      <WorkshopCanvasToolbar
        stageCount={model.nodes.length}
        zoom={view.zoom}
        canZoomIn={view.zoom < GRAPH_ZOOM_MAX}
        canZoomOut={view.zoom > GRAPH_ZOOM_MIN}
        viewDisabled={empty}
        onAddStage={onAddStage}
        onZoomIn={() => setView((current) => ({ ...current, zoom: stepZoom(current.zoom, 1) }))}
        onZoomOut={() => setView((current) => ({ ...current, zoom: stepZoom(current.zoom, -1) }))}
        onFit={fit}
        onAutoLayout={fit}
      />
      {empty ? (
        <WorkshopEmptyCanvas onAddStage={onAddStage} />
      ) : (
        <div
          ref={viewportRef}
          className={`relative flex min-h-0 w-full min-w-0 flex-1 touch-none select-none overflow-clip [background-image:radial-gradient(circle,_rgba(255,_255,_255,_0.06)_0%,_rgba(0,_0,_0,_0)_100%)] ${dragging ? "cursor-grabbing" : "cursor-grab"}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={(event) => endDrag(event, false)}
          onPointerCancel={(event) => endDrag(event, true)}
        >
          {model.hasChanges ? <ChangeLegend /> : null}
          <div className="flex w-full justify-center px-3 pb-2.5 pt-[42px]">
            <div
              ref={contentRef}
              className="flex shrink-0 flex-col items-center"
              style={{
                transform: `translate(${view.panX}px, ${view.panY}px) scale(${view.zoom})`,
                transformOrigin: "50% 0",
              }}
            >
              {model.rows.map((row, index) => (
                <Fragment key={index}>
                  <GraphRow
                    row={row}
                    width={model.width}
                    nodes={nodesById}
                    selectedStageId={selectedStageId}
                    onSelect={onSelectStage}
                  />
                  {model.connectors[index] ? (
                    <GraphConnector connector={model.connectors[index]!} />
                  ) : null}
                </Fragment>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
