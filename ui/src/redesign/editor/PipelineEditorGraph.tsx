import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { LuGitBranch, LuMinus, LuPlus, LuScan } from "react-icons/lu";
import type { DraftPackagePayload } from "../../api";
import {
  DEFAULT_GRAPH_VIEW,
  GRAPH_ZOOM_MAX,
  GRAPH_ZOOM_MIN,
  fitGraphView,
  stepZoom,
} from "../workshop/graph/graphViewport";
import type { GraphView } from "../workshop/graph/graphViewport";
import { EditorStageCard } from "./EditorStageCard";
import {
  buildEditorGraphLayout,
  editorGraphToolbarSummary,
  editorStageCardModel,
} from "./editorGraphLayout";
import type { ConnectorGeometry, StageStats } from "./editorGraphLayout";
import { buildEditorLiveGraph } from "./editorLiveGraph";

export type PipelineEditorGraphProps = {
  draft: DraftPackagePayload;
  selectedStageId: string | null;
  onSelectStage: (stageId: string) => void;
  onAddStage: () => void;
  defaultModel?: string | null;
  stageFindings?: Map<string, "error" | "warning">;
  stageStats?: Map<string, StageStats>;
  p50Ms?: number | null;
};

const NO_FINDINGS = new Map<string, "error" | "warning">();
const NO_STATS = new Map<string, StageStats>();

function lineClass(highlighted: boolean): string {
  return `absolute ${highlighted ? "bg-[#a7aab2]" : "bg-[#ffffff33]"}`;
}

function Connector({ geometry }: { geometry: ConnectorGeometry }) {
  return (
    <div className="relative shrink-0" style={{ width: geometry.width, height: geometry.height }}>
      {geometry.segments.map((segment, index) => (
        <div
          key={index}
          className={lineClass(segment.highlighted)}
          style={
            segment.axis === "x"
              ? { left: segment.left, top: segment.top, width: segment.length, height: 1 }
              : { left: segment.left, top: segment.top, width: 1, height: segment.length }
          }
        />
      ))}
    </div>
  );
}

export function PipelineEditorGraph({
  draft,
  selectedStageId,
  onSelectStage,
  onAddStage,
  defaultModel = null,
  stageFindings = NO_FINDINGS,
  stageStats = NO_STATS,
  p50Ms = null,
}: PipelineEditorGraphProps) {
  const graph = useMemo(() => buildEditorLiveGraph(draft), [draft]);
  const layout = useMemo(
    () => buildEditorGraphLayout(graph, selectedStageId),
    [graph, selectedStageId],
  );
  const cards = useMemo(() => {
    const map = new Map<string, ReturnType<typeof editorStageCardModel>>();
    for (const row of layout.rows) {
      for (const node of row.nodes) {
        map.set(node.stageId, editorStageCardModel(draft, node.stageId, defaultModel));
      }
    }
    return map;
  }, [draft, layout, defaultModel]);
  const [view, setView] = useState<GraphView>(DEFAULT_GRAPH_VIEW);
  const [layoutSize, setLayoutSize] = useState<{ width: number; height: number } | null>(
    null,
  );
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const empty = layout.stageCount === 0;

  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const width = content.offsetWidth;
    const height = content.offsetHeight;
    setLayoutSize((current) =>
      current && current.width === width && current.height === height
        ? current
        : { width, height },
    );
  });

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

  const railGutter = layout.width - layout.rowsWidth;

  return (
    <div className="editor-live-graph flex min-h-0 min-w-0 flex-1 flex-col bg-[#0c0d0f]">
      <div className="flex h-9 w-full shrink-0 items-center gap-2.5 border-b border-b-[#ffffff12] px-3.5">
        <LuGitBranch aria-hidden className="size-[13px] shrink-0 text-[#8b8f98]" />
        <span className="whitespace-nowrap text-xs font-medium text-[#ecedee]">Live graph</span>
        <span className="truncate whitespace-nowrap font-['Geist_Mono',monospace] text-[11px] text-[#8b8f98]">
          {editorGraphToolbarSummary(layout.stageCount, layout.lanes, p50Ms)}
        </span>
        <span className="min-w-0 flex-1" />
        <div className="flex h-6 shrink-0 items-center rounded-md border border-[#ffffff1a] bg-[#131418]">
          <button
            type="button"
            className="flex size-[22px] items-center justify-center rounded-md text-[#a7aab2] hover:bg-[#ffffff08] hover:text-[#ecedee] disabled:cursor-default disabled:opacity-40"
            onClick={() => setView((current) => ({ ...current, zoom: stepZoom(current.zoom, -1) }))}
            disabled={empty || view.zoom <= GRAPH_ZOOM_MIN}
            aria-label="Zoom out"
          >
            <LuMinus aria-hidden className="size-3" />
          </button>
          <span className="px-1 font-['Geist_Mono',monospace] text-[11px] text-[#a7aab2]">
            {Math.round(view.zoom * 100)}%
          </span>
          <button
            type="button"
            className="flex size-[22px] items-center justify-center rounded-md text-[#a7aab2] hover:bg-[#ffffff08] hover:text-[#ecedee] disabled:cursor-default disabled:opacity-40"
            onClick={() => setView((current) => ({ ...current, zoom: stepZoom(current.zoom, 1) }))}
            disabled={empty || view.zoom >= GRAPH_ZOOM_MAX}
            aria-label="Zoom in"
          >
            <LuPlus aria-hidden className="size-3" />
          </button>
        </div>
        <button
          type="button"
          className="flex size-6 shrink-0 items-center justify-center rounded-md border border-[#ffffff1a] bg-[#131418] text-[#a7aab2] hover:bg-[#ffffff08] hover:text-[#ecedee] disabled:cursor-default disabled:opacity-40"
          onClick={fit}
          disabled={empty}
          aria-label="Fit"
          title="Fit"
        >
          <LuScan aria-hidden className="size-3" />
        </button>
      </div>
      <div
        ref={viewportRef}
        className="relative min-h-0 w-full min-w-0 flex-1 overflow-auto [background-image:radial-gradient(circle,_rgba(255,255,255,0.07)_0%,_rgba(0,0,0,0)_100%)]"
      >
        <div className="flex min-h-full w-max min-w-full flex-col items-center justify-center py-4">
          <div
            className="overflow-hidden"
            style={
              layoutSize
                ? { width: layoutSize.width * view.zoom, height: layoutSize.height * view.zoom }
                : undefined
            }
          >
            <div
              ref={contentRef}
              className="flex w-max flex-col"
              style={{ transform: `scale(${view.zoom})`, transformOrigin: "top left" }}
            >
              {layout.rows.map((row, rowIndex) => (
                <div key={row.nodes.map((node) => node.key).join("|")}>
                  <div className="relative" style={{ width: layout.width }}>
                    <div className="flex justify-center gap-4" style={{ width: layout.rowsWidth }}>
                      {row.nodes.map((node) => (
                        <EditorStageCard
                          key={node.key}
                          stageId={node.stageId}
                          card={cards.get(node.stageId) ?? { model: null, gateKinds: [], needs: [] }}
                          selected={node.stageId === selectedStageId}
                          finding={stageFindings.get(node.stageId)}
                          stats={stageStats.get(node.stageId)}
                          loops={node.loops}
                          onSelect={onSelectStage}
                        />
                      ))}
                    </div>
                    {row.rails.map((rail, index) => (
                      <div
                        key={index}
                        className={`${lineClass(rail.highlighted)} top-0 bottom-0 w-px`}
                        style={{ left: rail.x }}
                      />
                    ))}
                  </div>
                  {layout.connectors[rowIndex] ? (
                    <Connector geometry={layout.connectors[rowIndex]} />
                  ) : null}
                </div>
              ))}
              <div
                className="flex justify-center"
                style={{ width: layout.rowsWidth || undefined, marginRight: railGutter || undefined }}
              >
                <button
                  type="button"
                  className="mt-3.5 flex h-7 items-center gap-1.5 rounded-lg border border-dashed border-[#ffffff24] px-2.5 hover:bg-[#ffffff08]"
                  onClick={onAddStage}
                  aria-keyshortcuts="A"
                >
                  <LuPlus aria-hidden className="size-3 text-[#8b8f98]" />
                  <span className="whitespace-nowrap text-xs text-[#a7aab2]">Add stage</span>
                  <span className="rounded-sm border border-[#ffffff1a] bg-[#1a1c21] px-[5px] font-['Geist_Mono',monospace] text-[11px] leading-[1.45455] text-[#8b8f98]">
                    A
                  </span>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
