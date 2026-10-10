import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { IconType } from "react-icons";
import {
  LuArchive,
  LuArrowDown,
  LuArrowRight,
  LuArrowUpRight,
  LuBookOpen,
  LuBraces,
  LuCheck,
  LuCircleAlert,
  LuCircleDashed,
  LuCopy,
  LuExternalLink,
  LuFileCode,
  LuFileText,
  LuFolder,
  LuHand,
  LuInfo,
  LuLayers,
  LuLoaderCircle,
  LuLock,
  LuPencil,
  LuX,
} from "react-icons/lu";
import {
  fetchCatalogFile,
  fetchCatalogValidate,
  fetchPipelines,
  fetchSkills,
  fetchSkillUsage,
  type CatalogValidationResult,
  type PipelineListing,
  type RunSummary,
  type SkillListing,
  type SkillUsageIndex,
} from "../../api";
import { displayCatalogPath } from "../../catalog/displayCatalogPath";
import { useRunCatalog } from "../../catalog/useRunCatalog";
import { catalogPath, navigate, pipelinePath } from "../../routes";
import { showToast } from "../../toast";
import { summaryStageStats, type StageStats } from "../editor/editorStageStats";
import { formatDurationShort } from "../editor/editorGraphLayout";
import { useHotkeys } from "../keys";
import { formatAgo, useNow } from "../workshop/relativeTime";
import {
  avgCellLabel,
  directoryKeyFor,
  fileBasename,
  filterStageRows,
  footerCountsLabel,
  gateChipSummary,
  groupStageRows,
  latestRunForPipeline,
  orderedRowKeys,
  passPercentLabel,
  pipelineForRow,
  promptPreviewLines,
  promptTokenHint,
  readStageYaml,
  recentStageStats,
  runStatusPill,
  skillStripEntries,
  stepSelection,
  type NewStageInitial,
  type StageYamlInfo,
} from "./catalogStageModel";
import { stagesFromPipelines, type StageRowFromPipelines } from "./stagesFromPipelines";

const MONO = "[font-family:'Geist_Mono',_monospace]";
const COLUMN_LABEL =
  "font-sans text-[11px] font-medium uppercase leading-normal tracking-[0.88px] text-[#8b8f98] whitespace-nowrap";
const FIELD_LABEL = `w-[116px] shrink-0 ${COLUMN_LABEL}`;
const READ_ONLY_TAG =
  "flex h-[18px] items-center gap-1 rounded-sm border border-[#ffffff1a] px-[5px] py-0";

export type CatalogStagesTabProps = {
  query: string;
  onNewStage: (initial?: NewStageInitial) => void;
};

type YamlState =
  | { status: "loading" }
  | { status: "ok"; info: StageYamlInfo }
  | { status: "error" };

type ValidationState =
  | { status: "loading" }
  | { status: "ok"; result: CatalogValidationResult; at: number }
  | { status: "error"; message: string };

export function CatalogStagesTab({ query, onNewStage }: CatalogStagesTabProps) {
  const [pipelines, setPipelines] = useState<PipelineListing[]>([]);
  const [rows, setRows] = useState<StageRowFromPipelines[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [skills, setSkills] = useState<SkillListing[]>([]);
  const [usage, setUsage] = useState<SkillUsageIndex | null>(null);
  const [validation, setValidation] = useState<ValidationState>({ status: "loading" });
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const initializedRef = useRef(false);
  const { snapshot } = useRunCatalog();
  const runs = snapshot.runs;

  const load = useCallback(async () => {
    try {
      const result = await fetchPipelines();
      setPipelines(result.pipelines);
      setRows(stagesFromPipelines(result.pipelines));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    fetchSkills()
      .then((result) => {
        if (!cancelled) setSkills(result.skills);
      })
      .catch(() => {
        if (!cancelled) setSkills([]);
      });
    fetchSkillUsage()
      .then((result) => {
        if (!cancelled) setUsage(result);
      })
      .catch(() => {
        if (!cancelled) setUsage(null);
      });
    fetchCatalogValidate({ strict: true })
      .then((result) => {
        if (!cancelled) setValidation({ status: "ok", result, at: Date.now() });
      })
      .catch((err) => {
        if (!cancelled)
          setValidation({
            status: "error",
            message: err instanceof Error ? err.message : String(err),
          });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const stats = useMemo(() => summaryStageStats(runs), [runs]);
  const visible = useMemo(() => filterStageRows(rows, query), [rows, query]);
  const groups = useMemo(() => groupStageRows(visible), [visible]);
  const order = useMemo(() => orderedRowKeys(groups), [groups]);

  useEffect(() => {
    if (loading) return;
    if (!initializedRef.current) {
      initializedRef.current = true;
      setSelectedKey(order[0] ?? null);
      return;
    }
    if (selectedKey !== null && !order.includes(selectedKey)) {
      setSelectedKey(order[0] ?? null);
    }
  }, [loading, order, selectedKey]);

  const selected = useMemo(
    () => rows.find((r) => r.rowKey === selectedKey) ?? null,
    [rows, selectedKey],
  );
  const selectedPipeline = useMemo(
    () => (selected ? pipelineForRow(selected, pipelines) : null),
    [selected, pipelines],
  );
  const editorHref = selectedPipeline
    ? `#${pipelinePath(selectedPipeline.id, {
        project_root: selectedPipeline.project_root,
      })}`
    : null;

  const [yamlState, setYamlState] = useState<YamlState | null>(null);
  const selectedPath = selected?.uses_path;
  const selectedRoot = selected?.project_root;
  useEffect(() => {
    if (!selectedPath) {
      setYamlState(null);
      return;
    }
    let cancelled = false;
    setYamlState({ status: "loading" });
    fetchCatalogFile({ path: selectedPath, project_root: selectedRoot })
      .then((file) => {
        if (!cancelled) setYamlState({ status: "ok", info: readStageYaml(file.content) });
      })
      .catch(() => {
        if (!cancelled) setYamlState({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [selectedPath, selectedRoot]);

  const duplicate = useCallback(() => {
    if (!selected) return;
    onNewStage({
      id: `${selected.id}-copy`,
      systemPrompt: yamlState?.status === "ok" ? (yamlState.info.systemPrompt ?? "") : "",
      model: selected.model,
      gateKinds: selected.gate_kinds,
      ...(selectedPipeline ? { directoryKey: directoryKeyFor(selectedPipeline) } : {}),
    });
  }, [selected, selectedPipeline, yamlState, onNewStage]);

  useHotkeys(
    [
      {
        key: "j",
        scope: "catalog",
        handler: (e) => {
          e.preventDefault();
          setSelectedKey((current) => stepSelection(order, current, 1));
        },
      },
      {
        key: "k",
        scope: "catalog",
        handler: (e) => {
          e.preventDefault();
          setSelectedKey((current) => stepSelection(order, current, -1));
        },
      },
      {
        key: "e",
        scope: "catalog",
        when: () => editorHref !== null,
        handler: (e) => {
          e.preventDefault();
          if (editorHref) navigate(editorHref);
        },
      },
    ],
    "catalog",
  );

  useEffect(() => {
    if (!selectedKey) return;
    const el = document.querySelector(`[data-stage-row="${CSS.escape(selectedKey)}"]`);
    if (el && "scrollIntoView" in el) (el as HTMLElement).scrollIntoView({ block: "nearest" });
  }, [selectedKey]);

  const stripEntries = useMemo(
    () => skillStripEntries(skills, usage, visible),
    [skills, usage, visible],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <InfoStrip />
          <div className="flex min-h-0 w-full flex-1 flex-col overflow-y-auto">
            <ColumnHeader />
            {error ? <p className="px-4 py-3 text-xs text-[#f2645a]">{error}</p> : null}
            {loading ? (
              <p className="px-4 py-3 text-xs text-[#8b8f98]">Loading stages…</p>
            ) : null}
            {!loading && !error && rows.length === 0 ? (
              <p className="px-4 py-3 text-xs text-[#8b8f98]">No stages in this catalog.</p>
            ) : null}
            {!loading && rows.length > 0 && visible.length === 0 ? (
              <p className="px-4 py-3 text-xs text-[#8b8f98]">No stages match “{query}”.</p>
            ) : null}
            {groups.inUse.length > 0 ? (
              <>
                <GroupHeading
                  icon={LuLayers}
                  label="In use"
                  count={groups.inUse.length}
                  hint="Sorted by pipelines using the stage"
                />
                {groups.inUse.map((row) => (
                  <StageRow
                    key={row.rowKey}
                    row={row}
                    stats={stats.get(row.id)}
                    selected={row.rowKey === selectedKey}
                    onSelect={() => setSelectedKey(row.rowKey)}
                  />
                ))}
              </>
            ) : null}
            {groups.unused.length > 0 ? (
              <>
                <GroupHeading
                  icon={LuCircleDashed}
                  label="Unused"
                  count={groups.unused.length}
                  hint="No pipeline references these yet"
                />
                {groups.unused.map((row) => (
                  <StageRow
                    key={row.rowKey}
                    row={row}
                    stats={stats.get(row.id)}
                    selected={row.rowKey === selectedKey}
                    onSelect={() => setSelectedKey(row.rowKey)}
                  />
                ))}
              </>
            ) : null}
          </div>
          {stripEntries.length > 0 ? (
            <SkillsStrip entries={stripEntries} total={skills.length} />
          ) : null}
        </div>
        <StageInspector
          row={selected}
          pipeline={selectedPipeline}
          editorHref={editorHref}
          yamlState={yamlState}
          runs={runs}
          onClose={() => setSelectedKey(null)}
          onDuplicate={duplicate}
        />
      </div>
      <FooterBar rows={rows} validation={validation} />
    </div>
  );
}

function InfoStrip() {
  return (
    <div className="flex h-fit min-h-9 w-full shrink-0 items-center gap-2 border-b border-b-[#ffffff12] bg-[#131418] px-4 py-2">
      <LuInfo className="size-3.5 shrink-0 text-[#8b8f98]" aria-hidden />
      <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-1">
        <span className="font-sans text-xs leading-[1.4] text-[#a7aab2]">
          Skills and extensions come from Pi and are read-only here.
        </span>
        <span className="font-sans text-xs leading-[1.4] text-[#a7aab2]">
          A stage uses a skill only when its YAML sets
        </span>
        <span className={`${MONO} text-xs leading-[1.4] text-[#ecedee]`}>skill:</span>
      </div>
      <button
        type="button"
        onClick={() => showToast("Set skill: on the pipeline stage entry. See docs/yaml-catalog.md.")}
        className="flex shrink-0 items-center gap-1 text-[#a7aab2] hover:text-[#ecedee]"
      >
        <span className="font-sans text-xs font-medium leading-normal">Learn how</span>
        <LuArrowUpRight className="size-3" aria-hidden />
      </button>
    </div>
  );
}

function ColumnHeader() {
  return (
    <div className="sticky top-0 z-[1] flex h-8 w-full shrink-0 items-center gap-2.5 border-b border-b-[#ffffff12] bg-[#0c0d0f] px-4 py-0">
      <div className={`min-w-0 flex-1 ${COLUMN_LABEL}`}>Stage id</div>
      <div className={`w-[198px] shrink-0 ${COLUMN_LABEL}`}>Model</div>
      <div className={`w-[120px] shrink-0 ${COLUMN_LABEL}`}>Gates</div>
      <div className={`w-[78px] shrink-0 ${COLUMN_LABEL}`}>Skill</div>
      <div className="flex w-[100px] shrink-0 items-center gap-1">
        <span className={`${COLUMN_LABEL} text-[#ecedee]`}>Used by</span>
        <LuArrowDown className="size-3 text-[#ecedee]" aria-hidden />
      </div>
      <div className={`w-[92px] shrink-0 text-right ${COLUMN_LABEL}`}>Avg</div>
      <div className={`w-9 shrink-0 text-right ${COLUMN_LABEL}`}>Pass</div>
    </div>
  );
}

function GroupHeading({
  icon: Icon,
  label,
  count,
  hint,
}: {
  icon: IconType;
  label: string;
  count: number;
  hint: string;
}) {
  return (
    <div className="flex h-8 w-full shrink-0 items-center gap-2 border-b border-b-[#ffffff12] px-4 py-0">
      <Icon className="size-[13px] text-[#8b8f98]" aria-hidden />
      <span className="font-sans text-[13px] font-semibold leading-normal text-[#ecedee]">
        {label}
      </span>
      <span className={`${MONO} text-xs leading-normal text-[#8b8f98]`}>{count}</span>
      <span className="block flex-1" />
      <span className="whitespace-nowrap font-sans text-xs leading-normal text-[#8b8f98]">
        {hint}
      </span>
    </div>
  );
}

function GateCell({ kinds, muted }: { kinds?: string[]; muted: boolean }) {
  const { first, extra } = gateChipSummary(kinds);
  if (!first) {
    return (
      <div className="flex w-[120px] shrink-0 items-center gap-1">
        <span className={`${MONO} whitespace-nowrap text-[11px] leading-normal text-[#8b8f98]`}>
          no gate
        </span>
      </div>
    );
  }
  const chip = `h-5 content-center whitespace-nowrap rounded-[5px] border px-1.5 py-0 ${MONO} text-[11px] leading-normal`;
  const tone = muted
    ? "border-[#ffffff12] text-[#8b8f98]"
    : "border-[#ffffff1a] bg-[#1a1c21] text-[#a7aab2]";
  return (
    <div className="flex w-[120px] min-w-0 shrink-0 items-center gap-1">
      <span
        className={`${chip} ${tone} min-w-0 truncate ${first === "artifact_backed" ? "border-dashed" : ""}`}
        title={kinds?.join(", ")}
      >
        {first}
      </span>
      {extra > 0 ? <span className={`${chip} ${tone} shrink-0`}>+{extra}</span> : null}
    </div>
  );
}

function StageRow({
  row,
  stats,
  selected,
  onSelect,
}: {
  row: StageRowFromPipelines;
  stats?: StageStats;
  selected: boolean;
  onSelect: () => void;
}) {
  const unused = row.used_by_pipeline_ids.length === 0;
  const firstPipeline = row.used_by_pipeline_ids[0];
  const passLabel = passPercentLabel(stats?.passRate);
  return (
    <div
      role="option"
      aria-selected={selected}
      tabIndex={-1}
      data-stage-row={row.rowKey}
      onClick={onSelect}
      className={`flex h-10 w-full shrink-0 cursor-pointer items-center gap-2.5 border-b border-b-[#ffffff12] py-0 pl-3.5 pr-4 ${
        selected
          ? "border-l-2 border-l-[#ecedee] bg-[#131418]"
          : "border-l-2 border-l-transparent hover:bg-[#131418]"
      }`}
    >
      <div
        className={`min-w-0 flex-1 truncate ${MONO} text-[13px] leading-normal ${
          selected ? "font-medium" : ""
        } ${unused ? "text-[#a7aab2]" : "text-[#ecedee]"}`}
        title={row.project_root ? `${row.id} · ${row.project_root}` : row.id}
      >
        {row.id}
      </div>
      <div
        className={`w-[198px] min-w-0 shrink-0 truncate ${MONO} text-[11px] leading-normal ${
          unused ? "text-[#8b8f98]" : "text-[#a7aab2]"
        }`}
        title={row.model}
      >
        {row.model ?? "—"}
      </div>
      <GateCell kinds={row.gate_kinds} muted={unused} />
      <div className="w-[78px] min-w-0 shrink-0">
        {row.skill ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              navigate(catalogPath({ tab: "skills", skill: row.skill }));
            }}
            className={`block max-w-full truncate text-left ${MONO} text-[11px] leading-normal text-[#ecedee] hover:underline hover:decoration-[#ecedee59] hover:underline-offset-2`}
            title={`Open skill ${row.skill}`}
          >
            {row.skill}
          </button>
        ) : (
          <span className={`${MONO} text-[11px] leading-normal text-[#8b8f98]`}>—</span>
        )}
      </div>
      <div className="flex w-[100px] min-w-0 shrink-0 items-baseline gap-1.5">
        {unused ? (
          <>
            <span className={`${MONO} text-xs leading-normal text-[#8b8f98]`}>0</span>
            <span className="h-[18px] content-center rounded-sm border border-dashed border-[#ffffff2e] px-[5px] py-0 font-sans text-[11px] leading-normal text-[#8b8f98]">
              unused
            </span>
          </>
        ) : (
          <>
            <span className={`shrink-0 ${MONO} text-xs font-medium leading-normal text-[#ecedee]`}>
              {row.used_by_pipeline_ids.length}
            </span>
            <span
              className={`min-w-0 truncate ${MONO} text-[11px] leading-normal text-[#8b8f98]`}
              title={row.used_by_pipeline_ids.join(", ")}
            >
              {firstPipeline}
            </span>
          </>
        )}
      </div>
      <div
        className={`w-[92px] shrink-0 truncate text-right ${MONO} text-[11px] leading-normal ${
          stats && stats.runs > 0 ? "text-[#a7aab2]" : "text-[#8b8f98]"
        }`}
      >
        {avgCellLabel(stats)}
      </div>
      <div
        className={`w-9 shrink-0 text-right ${MONO} text-xs leading-normal ${
          passLabel === "—" ? "text-[#8b8f98]" : "text-[#ecedee]"
        }`}
      >
        {passLabel}
      </div>
    </div>
  );
}

function SkillsStrip({
  entries,
  total,
}: {
  entries: { name: string; stageId: string }[];
  total: number;
}) {
  return (
    <div className="flex h-fit w-full shrink-0 flex-col gap-2.5 border-t border-t-[#ffffff12] px-4 pb-3.5 pt-3">
      <div className="flex w-full items-center gap-2">
        <span className={COLUMN_LABEL}>Skills used by stages</span>
        <span className={READ_ONLY_TAG}>
          <LuLock className="size-2.5 text-[#8b8f98]" aria-hidden />
          <span className="font-sans text-[11px] leading-normal text-[#8b8f98]">read-only · Pi</span>
        </span>
        <span className="block flex-1" />
        <button
          type="button"
          onClick={() => navigate(catalogPath({ tab: "skills" }))}
          className="flex items-center gap-1 text-[#a7aab2] hover:text-[#ecedee]"
        >
          <span className="font-sans text-xs font-medium leading-normal">
            View all {total} skills
          </span>
          <LuArrowRight className="size-3" aria-hidden />
        </button>
      </div>
      <div className="flex w-full flex-wrap items-center gap-2">
        {entries.map((entry) => (
          <button
            key={entry.name}
            type="button"
            onClick={() => navigate(catalogPath({ tab: "skills", skill: entry.name }))}
            className="flex h-[30px] items-center gap-1.5 rounded-lg border border-[#ffffff12] bg-[#131418] px-2.5 py-0 hover:border-[#ffffff1a]"
          >
            <LuBookOpen className="size-3 shrink-0 text-[#a7aab2]" aria-hidden />
            <span className={`${MONO} whitespace-nowrap text-xs leading-normal text-[#ecedee]`}>
              {entry.name}
            </span>
            <span className="whitespace-nowrap font-sans text-xs leading-normal text-[#8b8f98]">
              · used by
            </span>
            <span className={`${MONO} whitespace-nowrap text-xs leading-normal text-[#a7aab2]`}>
              {entry.stageId}
            </span>
            <LuLock className="ml-0.5 size-[11px] shrink-0 text-[#8b8f98]" aria-hidden />
          </button>
        ))}
      </div>
    </div>
  );
}

function FooterBar({
  rows,
  validation,
}: {
  rows: StageRowFromPipelines[];
  validation: ValidationState;
}) {
  const now = useNow(30_000);
  return (
    <div className="flex h-10 w-full shrink-0 items-center gap-3 border-t border-t-[#ffffff12] bg-[#08090a] px-4 py-0">
      <LuFolder className="size-3.5 shrink-0 text-[#8b8f98]" aria-hidden />
      <span className="whitespace-nowrap font-sans text-xs leading-normal text-[#8b8f98]">
        {footerCountsLabel(rows)}
      </span>
      <span className="block min-w-0 flex-1" />
      <div className="flex min-w-0 items-center gap-1.5">
        {validation.status === "ok" && validation.result.summary.errors === 0 ? (
          <>
            <LuCheck className="size-3.5 shrink-0 text-[#4cc38a]" aria-hidden />
            <span className="font-sans text-xs font-medium leading-normal text-[#4cc38a]">Valid</span>
          </>
        ) : null}
        {validation.status === "ok" && validation.result.summary.errors > 0 ? (
          <>
            <LuCircleAlert className="size-3.5 shrink-0 text-[#f2645a]" aria-hidden />
            <span className="whitespace-nowrap font-sans text-xs font-medium leading-normal text-[#f2645a]">
              {validation.result.summary.errors}{" "}
              {validation.result.summary.errors === 1 ? "error" : "errors"}
            </span>
          </>
        ) : null}
        {validation.status === "error" ? (
          <span
            className="min-w-0 truncate font-sans text-xs leading-normal text-[#8b8f98]"
            title={validation.message}
          >
            {validation.message}
          </span>
        ) : null}
        <span className={`whitespace-nowrap ${MONO} text-xs leading-normal text-[#8b8f98]`}>
          sf validate --strict
          {validation.status === "ok" ? ` · ${formatAgo(validation.at, now)}` : ""}
          {validation.status === "loading" ? " · running…" : ""}
        </span>
      </div>
    </div>
  );
}

const PILL_ICONS: Record<string, IconType> = {
  Succeeded: LuCheck,
  Failed: LuX,
  Running: LuLoaderCircle,
  "Needs you": LuHand,
  Cancelled: LuCircleDashed,
};

function StageInspector({
  row,
  pipeline,
  editorHref,
  yamlState,
  runs,
  onClose,
  onDuplicate,
}: {
  row: StageRowFromPipelines | null;
  pipeline: PipelineListing | null;
  editorHref: string | null;
  yamlState: YamlState | null;
  runs: RunSummary[];
  onClose: () => void;
  onDuplicate: () => void;
}) {
  const now = useNow(60_000);
  const recent = useMemo(
    () =>
      row ? recentStageStats(runs, row.id, row.used_by_pipeline_ids, now) : null,
    [row, runs, now],
  );

  if (!row) {
    return (
      <aside className="flex w-[420px] shrink-0 flex-col items-center justify-center border-l border-l-[#ffffff12] bg-[#131418]">
        <p className="font-sans text-xs text-[#8b8f98]">Select a stage</p>
      </aside>
    );
  }

  const usedCount = row.used_by_pipeline_ids.length;
  const skillFile = row.uses_path
    ? fileBasename(row.uses_path)
    : pipeline
      ? fileBasename(pipeline.path)
      : null;
  const archiveTitle =
    usedCount > 0 ? `Archive is off: used by ${usedCount} pipelines` : "Archive is off";
  const stats = recent?.stats ?? null;

  return (
    <aside className="flex w-[420px] shrink-0 flex-col border-l border-l-[#ffffff12] bg-[#131418]">
      <div className="flex w-full flex-col gap-2 border-b border-b-[#ffffff12] px-3.5 py-3">
        <div className="flex items-center gap-1.5">
          <span className={`flex-1 ${COLUMN_LABEL}`}>Stage</span>
          <button
            type="button"
            aria-label="Close inspector"
            onClick={onClose}
            className="text-[#8b8f98] hover:text-[#ecedee]"
          >
            <LuX className="size-3.5" aria-hidden />
          </button>
        </div>
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={`min-w-0 truncate ${MONO} text-[15px] font-semibold leading-normal text-[#ecedee]`}
          >
            {row.id}
          </span>
          <span className="h-[18px] shrink-0 content-center rounded-sm border border-[#ffffff1a] px-[5px] py-0 font-sans text-[11px] leading-normal text-[#a7aab2]">
            {row.uses_path ? "editable" : "inline"}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <LuFileCode className="size-3 shrink-0 text-[#8b8f98]" aria-hidden />
          <span
            className={`min-w-0 flex-1 truncate ${MONO} text-xs leading-normal text-[#8b8f98]`}
            title={row.uses_path}
          >
            {row.uses_path
              ? displayCatalogPath(row.uses_path)
              : `inline in ${row.used_by_pipeline_ids[0] ?? "pipeline"}`}
          </span>
          {editorHref ? (
            <a
              href={editorHref}
              className="flex h-[26px] shrink-0 items-center gap-1.5 rounded-md px-2 py-0 text-[#a7aab2] hover:bg-[#1a1c21] hover:text-[#ecedee]"
            >
              <LuExternalLink className="size-3" aria-hidden />
              <span className="font-sans text-xs font-medium leading-normal">Open in editor</span>
            </a>
          ) : null}
        </div>
      </div>
      <div className="flex min-h-0 w-full flex-1 flex-col gap-3.5 overflow-y-auto p-3.5">
        <div className="flex flex-col gap-2">
          <div className="flex min-h-6 items-center gap-2">
            <span className={FIELD_LABEL}>model</span>
            <span
              className={`min-w-0 flex-1 truncate ${MONO} text-xs leading-normal ${
                row.model ? "text-[#ecedee]" : "text-[#8b8f98]"
              }`}
            >
              {row.model ?? "—"}
            </span>
          </div>
          <div className="flex min-h-6 items-center gap-2">
            <span className={FIELD_LABEL}>gate_kinds</span>
            <div className="flex flex-1 flex-wrap items-center gap-1">
              {row.gate_kinds && row.gate_kinds.length > 0 ? (
                row.gate_kinds.map((kind) => (
                  <span
                    key={kind}
                    className="flex h-[22px] items-center gap-1 rounded-[5px] border border-[#ffffff1a] bg-[#1a1c21] px-[7px] py-0"
                  >
                    {kind === "artifact_backed" ? (
                      <LuFileText className="size-[11px] text-[#a7aab2]" aria-hidden />
                    ) : null}
                    <span className={`${MONO} text-[11px] leading-normal text-[#ecedee]`}>{kind}</span>
                  </span>
                ))
              ) : (
                <span className={`${MONO} text-xs leading-normal text-[#8b8f98]`}>no gate</span>
              )}
            </div>
          </div>
          <div className="flex items-start gap-2">
            <span className={`${FIELD_LABEL} pt-[5px]`}>skill</span>
            {row.skill ? (
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => navigate(catalogPath({ tab: "skills", skill: row.skill }))}
                    className="flex h-6 min-w-0 items-center gap-1.5 rounded-md border border-[#ffffff1a] bg-[#1a1c21] px-[7px] py-0"
                  >
                    <LuBookOpen className="size-3 shrink-0 text-[#a7aab2]" aria-hidden />
                    <span
                      className={`truncate ${MONO} text-xs leading-normal text-[#ecedee] underline decoration-[#ecedee59] underline-offset-2`}
                    >
                      {row.skill}
                    </span>
                    <LuArrowRight className="size-3 shrink-0 text-[#a7aab2]" aria-hidden />
                  </button>
                  <span className={READ_ONLY_TAG}>
                    <LuLock className="size-2.5 text-[#8b8f98]" aria-hidden />
                    <span className="whitespace-nowrap font-sans text-[11px] leading-normal text-[#8b8f98]">
                      read-only · Pi
                    </span>
                  </span>
                </div>
                {skillFile ? (
                  <span className="font-sans text-[11px] leading-[1.4] text-[#8b8f98]">
                    Loaded via skill: in {skillFile}
                  </span>
                ) : null}
              </div>
            ) : (
              <span className="pt-[3px] font-sans text-xs leading-normal text-[#8b8f98]">
                No skill
              </span>
            )}
          </div>
        </div>
        <SystemPromptField row={row} yamlState={yamlState} />
        <div className="flex min-h-6 items-center gap-2">
          <span className={FIELD_LABEL}>payload_schema</span>
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            <LuBraces className="size-3 shrink-0 text-[#a7aab2]" aria-hidden />
            <span
              className={`min-w-0 truncate ${MONO} text-xs leading-normal ${
                yamlState?.status === "ok" && yamlState.info.payloadSchema !== "none"
                  ? "text-[#ecedee]"
                  : "text-[#8b8f98]"
              }`}
            >
              {!row.uses_path
                ? "inline"
                : yamlState?.status === "ok"
                  ? yamlState.info.payloadSchema
                  : yamlState?.status === "loading"
                    ? "…"
                    : "none"}
            </span>
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-1.5">
            <span className={COLUMN_LABEL}>Used by</span>
            <span className={`${MONO} text-[11px] leading-normal text-[#a7aab2]`}>{usedCount}</span>
            <span className="block flex-1" />
            <span className="font-sans text-[11px] leading-normal text-[#8b8f98]">latest run</span>
          </div>
          {usedCount > 0 ? (
            <div className="flex flex-col rounded-[10px] border border-[#ffffff12]">
              {row.used_by_pipeline_ids.map((pipelineId, index) => {
                const pill = runStatusPill(latestRunForPipeline(runs, pipelineId));
                const Icon = pill ? PILL_ICONS[pill.label] : undefined;
                return (
                  <div
                    key={pipelineId}
                    className={`flex h-9 items-center gap-2.5 px-2.5 py-0 ${
                      index < usedCount - 1 ? "border-b border-b-[#ffffff12]" : ""
                    }`}
                  >
                    <span
                      className={`min-w-0 flex-1 truncate ${MONO} text-xs leading-normal text-[#ecedee]`}
                    >
                      {pipelineId}
                    </span>
                    {pill ? (
                      <span
                        className="flex w-[90px] shrink-0 items-center justify-end gap-1"
                        style={{ color: pill.color }}
                      >
                        {Icon ? <Icon className="size-3" aria-hidden /> : null}
                        <span className="whitespace-nowrap font-sans text-xs font-medium leading-normal">
                          {pill.label}
                        </span>
                      </span>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : (
            <span className="font-sans text-xs text-[#8b8f98]">No pipeline uses this stage.</span>
          )}
        </div>
        <div className="flex flex-col gap-1.5">
          <span className={COLUMN_LABEL}>Last 30 days</span>
          <div className="flex rounded-[10px] border border-[#ffffff12] bg-[#0c0d0f]">
            <StatCell value={String(recent?.runs ?? 0)} label="Runs" first />
            <StatCell
              value={
                stats?.avgMs !== undefined && Number.isFinite(stats.avgMs)
                  ? formatDurationShort(stats.avgMs)
                  : "—"
              }
              label="Avg time"
            />
            <StatCell
              value={
                stats?.avgCostUsd !== undefined && Number.isFinite(stats.avgCostUsd)
                  ? `$${stats.avgCostUsd.toFixed(2)}`
                  : "—"
              }
              label="Avg cost"
            />
            <StatCell value={passPercentLabel(stats?.passRate)} label="Pass" />
          </div>
        </div>
      </div>
      <div className="flex w-full flex-col gap-2 border-t border-t-[#ffffff12] px-3.5 py-3">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            disabled={!editorHref}
            title={editorHref ? undefined : "Inline stage"}
            onClick={() => {
              if (editorHref) navigate(editorHref);
            }}
            className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-[#ecedee] px-2.5 py-0 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <LuPencil className="size-3.5 text-[#0c0d0f]" aria-hidden />
            <span className="font-sans text-[13px] font-medium leading-normal text-[#0c0d0f]">
              Edit stage
            </span>
            <span
              className={`rounded-sm border border-[#0c0d0f2e] px-[5px] py-0 ${MONO} text-[11px] leading-normal text-[#5a5d66]`}
            >
              E
            </span>
          </button>
          <button
            type="button"
            onClick={onDuplicate}
            className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-[#ffffff1a] bg-[#1a1c21] px-2.5 py-0"
          >
            <LuCopy className="size-3.5 text-[#a7aab2]" aria-hidden />
            <span className="font-sans text-[13px] font-medium leading-normal text-[#ecedee]">
              Duplicate
            </span>
          </button>
          <span className="block flex-1" />
          <button
            type="button"
            disabled
            title={archiveTitle}
            className="flex h-8 shrink-0 cursor-not-allowed items-center gap-1.5 rounded-lg px-2 py-0"
          >
            <LuArchive className="size-3.5 text-[#8b8f98]" aria-hidden />
            <span className="font-sans text-[13px] font-medium leading-normal text-[#8b8f98]">
              Archive
            </span>
          </button>
        </div>
        <div className="flex items-center gap-1.5">
          <LuInfo className="size-3 shrink-0 text-[#8b8f98]" aria-hidden />
          <span className="font-sans text-xs leading-normal text-[#8b8f98]">{archiveTitle}</span>
        </div>
      </div>
    </aside>
  );
}

function SystemPromptField({
  row,
  yamlState,
}: {
  row: StageRowFromPipelines;
  yamlState: YamlState | null;
}) {
  const prompt = yamlState?.status === "ok" ? yamlState.info.systemPrompt : null;
  const lines = prompt ? promptPreviewLines(prompt) : [];
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center">
        <span className={`flex-1 ${COLUMN_LABEL}`}>system_prompt</span>
        {prompt ? (
          <span className={`${MONO} text-[11px] leading-normal text-[#8b8f98]`}>
            {promptTokenHint(prompt)}
          </span>
        ) : null}
      </div>
      <div className="flex flex-col gap-0.5 rounded-lg border border-[#ffffff1a] bg-[#1a1c21] px-2.5 py-2">
        {!row.uses_path ? (
          <span className="font-sans text-[11px] leading-[1.55] text-[#8b8f98]">
            Prompt is inline in the pipeline.
          </span>
        ) : yamlState?.status === "loading" ? (
          <span className="font-sans text-[11px] leading-[1.55] text-[#8b8f98]">Loading…</span>
        ) : lines.length > 0 ? (
          lines.map((line, index) => (
            <span
              key={index}
              className={`truncate whitespace-pre ${MONO} text-[11px] leading-[1.55] ${
                index === lines.length - 1 && lines.length === 4 ? "text-[#8b8f98]" : "text-[#a7aab2]"
              }`}
            >
              {line}
            </span>
          ))
        ) : (
          <span className="font-sans text-[11px] leading-[1.55] text-[#8b8f98]">
            No system prompt in this file
          </span>
        )}
      </div>
    </div>
  );
}

function StatCell({ value, label, first }: { value: string; label: string; first?: boolean }) {
  return (
    <div
      className={`flex flex-1 flex-col gap-0.5 px-2.5 py-2 ${
        first ? "" : "border-l border-l-[#ffffff12]"
      }`}
    >
      <span className={`${MONO} text-sm font-medium leading-normal text-[#ecedee]`}>{value}</span>
      <span className="font-sans text-[11px] leading-normal text-[#8b8f98]">{label}</span>
    </div>
  );
}
