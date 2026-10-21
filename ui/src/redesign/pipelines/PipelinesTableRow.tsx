import type { PipelineListRow } from "./pipelineViews";
import { relativeTime, stageMayAsk } from "../../catalogJoin";
import { MiniTrack } from "../../components/MiniTrack";
import { runDisplayStatus } from "../../status/runStatus";
import { NeverRunPill } from "../NeverRunPill";
import { StatusPill } from "../StatusPill";
import { runStatusPillLabel, statusSignalFromRun } from "../statusSignal";

const EM_DASH = "—";

const HEAD =
  "whitespace-nowrap text-[11px] font-medium uppercase tracking-[0.88px] text-[var(--sf-text-3)]";

const PIPE_COL = "min-w-0 flex-1";
const STAGES_COL = "w-14 shrink-0";
const COUNT_COL = "w-6 shrink-0 text-right";
const ROOT_COL = "w-[112px] min-w-0 shrink-0";
const GATES_COL = "w-[152px] shrink-0";
const RUNS_COL = "w-8 shrink-0 text-right";
const LAST_COL = "w-[112px] shrink-0";
const AVG_COL = "w-[108px] shrink-0 text-right";

const ROW_GRID = "flex w-full items-center gap-2 px-5";

function metricClass(value: string): string {
  const muted = value === EM_DASH;
  return `font-['Geist_Mono',monospace] text-xs ${
    muted ? "text-[var(--sf-text-3)]" : "text-[var(--sf-text-2)]"
  }`;
}

function gateChip(label: string) {
  return (
    <span className="inline-flex h-5 shrink-0 items-center whitespace-nowrap rounded-[5px] border border-[#ffffff1a] bg-[var(--sf-raised)] px-1.5 font-['Geist_Mono',monospace] text-[11px] text-[var(--sf-text-2)]">
      {label}
    </span>
  );
}

export function PipelinesColumnHeader({ showRoot }: { showRoot: boolean }) {
  return (
    <div className={`${ROW_GRID} h-8 shrink-0 border-b border-b-[#ffffff12]`}>
      <div className={`${PIPE_COL} ${HEAD}`}>Pipeline</div>
      <div className={`${STAGES_COL} ${HEAD}`}>Stages</div>
      <div className={`${COUNT_COL} ${HEAD}`}>#</div>
      {showRoot ? <div className={`${ROOT_COL} ${HEAD}`}>Catalog root</div> : null}
      <div className={`${GATES_COL} ${HEAD}`}>Gates</div>
      <div className={`${RUNS_COL} ${HEAD}`}>Runs</div>
      <div className={`${LAST_COL} ${HEAD}`}>Last run</div>
      <div className={`${AVG_COL} ${HEAD}`}>Avg</div>
    </div>
  );
}

function LastRunCell({
  row,
  catalogFailed,
}: {
  row: PipelineListRow;
  catalogFailed: boolean;
}) {
  if (catalogFailed) {
    return <span className={metricClass(EM_DASH)}>{EM_DASH}</span>;
  }
  if (row.stats.neverRun || !row.stats.lastRun) {
    return <NeverRunPill />;
  }
  const last = row.stats.lastRun;
  const display = runDisplayStatus(last);
  return (
    <span className="flex flex-col items-start gap-0.5">
      <StatusPill
        signal={statusSignalFromRun(last)}
        label={runStatusPillLabel(display)}
      />
      <span className="font-['Geist_Mono',monospace] text-xs text-[var(--sf-text-3)]">
        {relativeTime(last.created_at)}
      </span>
    </span>
  );
}

export function PipelinesTableRow({
  row,
  selected,
  showRoot,
  catalogFailed,
  onSelect,
  onOpen,
}: {
  row: PipelineListRow;
  selected: boolean;
  showRoot: boolean;
  catalogFailed: boolean;
  onSelect: () => void;
  onOpen: () => void;
}) {
  const runsLabel = catalogFailed ? EM_DASH : row.stats.runsLabel;
  const avgLabel = catalogFailed ? EM_DASH : row.stats.tableAvg;
  const stages = row.pipeline.stages.map((stage) => ({
    id: stage.id,
    status: stageMayAsk(stage.gate_kinds)
      ? ("waiting_for_input" as const)
      : ("pending" as const),
  }));

  return (
    <button
      type="button"
      data-pipeline-row={row.key}
      onClick={onSelect}
      onDoubleClick={onOpen}
      aria-pressed={selected}
      className={`${ROW_GRID} min-h-[44px] cursor-pointer border-b border-b-[#ffffff12] text-left ${
        selected
          ? "bg-[var(--sf-active)]"
          : "bg-transparent hover:bg-[var(--sf-raised)]"
      }`}
    >
      <div className={`${PIPE_COL} flex flex-col gap-0.5`}>
        <div
          className="truncate text-[13px] font-medium text-[var(--sf-text-1)]"
          title={row.pipeline.id}
        >
          {row.pipeline.id}
        </div>
        <div
          className="truncate font-['Geist_Mono',monospace] text-xs text-[var(--sf-text-3)]"
          title={row.catalogPath}
        >
          {row.stageChain}
        </div>
      </div>
      <div className={STAGES_COL}>
        <MiniTrack stages={stages} variant="bar" />
      </div>
      <div className={`${COUNT_COL} font-['Geist_Mono',monospace] text-xs text-[var(--sf-text-2)]`}>
        {row.stageCount}
      </div>
      {showRoot ? (
        <div className={`${ROOT_COL} flex flex-col gap-0.5`}>
          <div
            className="truncate text-[13px] text-[var(--sf-text-2)]"
            title={row.pipeline.project_root}
          >
            {row.catalogRootBasename || EM_DASH}
          </div>
          {selected ? (
            <div
              className="truncate font-['Geist_Mono',monospace] text-xs text-[var(--sf-text-3)]"
              title={row.catalogPath}
            >
              {row.catalogPath}
            </div>
          ) : null}
        </div>
      ) : null}
      <div className={`${GATES_COL} flex items-center gap-1`}>
        {row.gates.kind === "none" ? (
          <span className="text-[13px] text-[var(--sf-text-3)]">none</span>
        ) : (
          <>
            {gateChip(row.gates.firstLabel)}
            {row.gates.extraCount > 0 ? gateChip(`+${row.gates.extraCount}`) : null}
          </>
        )}
      </div>
      <div className={`${RUNS_COL} ${metricClass(runsLabel)}`}>{runsLabel}</div>
      <div className={LAST_COL}>
        <LastRunCell row={row} catalogFailed={catalogFailed} />
      </div>
      <div className={`${AVG_COL} ${metricClass(avgLabel)}`}>{avgLabel}</div>
    </button>
  );
}
