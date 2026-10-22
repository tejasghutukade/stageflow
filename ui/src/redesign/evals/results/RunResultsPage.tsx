import { useRef, useState } from "react";
import { LuChevronLeft, LuChevronRight, LuDownload, LuGitCompareArrows, LuPencil, LuPlay, LuTriangleAlert } from "react-icons/lu";
import { fetchEvalRunByNumber, startEvalRun } from "../../../api";
import type { EvalRunDetail } from "../../../api/evalTypes";
import {
  evalCasePath,
  evalComparePath,
  evalEditPath,
  evalRunPath,
  evalsPath,
  navigate,
  type EvalRunTab,
} from "../../../routes";
import { FilterTabs } from "../../shell/FilterTabs";
import { PageHeader } from "../../shell/PageHeader";
import { openRunDialog } from "../run/runDialogStore";
import { CaseDrawer } from "./CaseDrawer";
import { CasesTab } from "./CasesTab";
import { ConfigTab } from "./ConfigTab";
import { GradersTab } from "./GradersTab";
import { OverviewTab } from "./OverviewTab";
import { Chip, ButtonLike, MONO_CLASS } from "./ResultsParts";
import { EMPTY_FILTER, filterWithGrader, filterWithTag, type CasesFilter } from "./casesModel";
import { rerunOverrides, usedRealTools } from "./configModel";
import {
  footerText,
  headerSubtitle,
  partialBanner,
  previousRunNumber,
  resultChip,
  resultsTabs,
  runPosition,
  suiteTypeLabel,
  type ResultsTabId,
} from "./headerModel";
import { downloadRunExport } from "./resultsApi";
import { useAllRows, useFailureTypes, useRunNumbers } from "./useResultsData";

export function RunResultsPage({
  run: polledRun,
  tab,
  caseId,
  repeat,
  drawerTab,
}: {
  run: EvalRunDetail;
  tab?: EvalRunTab;
  caseId?: string;
  repeat?: number;
  drawerTab?: "transcript";
}) {
  const [fresh, setFresh] = useState<EvalRunDetail | null>(null);
  const run = fresh && fresh.eval_run_id === polledRun.eval_run_id ? fresh : polledRun;
  const evalId = run.eval_id;
  const runNumber = run.run_number;
  const lastTab = useRef<ResultsTabId>(tab ?? "cases");
  if (caseId === undefined) lastTab.current = tab ?? "overview";
  const activeTab: ResultsTabId = caseId === undefined ? (tab ?? "overview") : lastTab.current;

  const [filter, setFilter] = useState<CasesFilter>(EMPTY_FILTER);
  const [rerunBusy, setRerunBusy] = useState(false);
  const [rerunError, setRerunError] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  const runNumbers = useRunNumbers(evalId);
  const allRows = useAllRows(run.eval_run_id);
  const failureTypes = useFailureTypes(evalId);

  const previous = previousRunNumber(runNumbers, runNumber);
  const position = runPosition(runNumbers, runNumber);
  const chip = resultChip(run);
  const banner = partialBanner(run);
  const tabs = resultsTabs(run, null);
  const rows = allRows ?? [];
  const caseIds = [...rows].sort((a, b) => a.position - b.position).map((r) => r.case_id);
  const flakySet = new Set(run.stats?.flaky_cases ?? []);

  const goTab = (id: ResultsTabId) => navigate(evalRunPath(evalId, runNumber, { tab: id }));
  const openCase = (id: string, repeatIndex?: number) =>
    navigate(evalCasePath(evalId, runNumber, id, repeatIndex !== undefined ? { repeat: repeatIndex } : undefined));
  const closeDrawer = () => navigate(evalRunPath(evalId, runNumber, { tab: lastTab.current }));

  function showCases(next: CasesFilter) {
    setFilter(next);
    goTab("cases");
  }

  async function rerun() {
    if (usedRealTools(run)) {
      openRunDialog(evalId);
      return;
    }
    setRerunBusy(true);
    setRerunError(null);
    try {
      const started = await startEvalRun(evalId, rerunOverrides(run));
      navigate(evalRunPath(evalId, started.run_number));
    } catch (err) {
      setRerunError(err instanceof Error ? err.message : String(err));
    } finally {
      setRerunBusy(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-[var(--sf-ground)]">
      <PageHeader
        title={evalId}
        crumbs={[{ label: "Evals", onClick: () => navigate(evalsPath()) }]}
        subtitle={headerSubtitle(run)}
        titleAddon={
          <>
            <Chip mono>Run #{runNumber}</Chip>
            <Chip tone="running" >{suiteTypeLabel(run)}</Chip>
            <Chip tone={chip.tone}>{chip.text}</Chip>
          </>
        }
        actions={
          <>
            <ButtonLike onClick={() => navigate(evalEditPath(evalId))}>
              <LuPencil className="size-3.5" aria-hidden />
              Edit eval
            </ButtonLike>
            {previous !== null ? (
              <ButtonLike onClick={() => navigate(evalComparePath(evalId, { a: previous, b: runNumber }))}>
                <LuGitCompareArrows className="size-3.5" aria-hidden />
                Compare with #{previous}
              </ButtonLike>
            ) : null}
            <ButtonLike
              onClick={() => {
                setExportError(null);
                downloadRunExport(run, "results").catch((err) => setExportError(err instanceof Error ? err.message : String(err)));
              }}
            >
              <LuDownload className="size-3.5" aria-hidden />
              Export
            </ButtonLike>
            <ButtonLike primary onClick={() => openRunDialog(evalId)}>
              <LuPlay className="size-3.5" aria-hidden />
              Run again
            </ButtonLike>
          </>
        }
      />
      <FilterTabs variant="underline" tabs={tabs} activeId={activeTab} onChange={(id) => goTab(id as ResultsTabId)} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {banner ? (
          <div
            role="alert"
            className="mx-5 mt-4 flex items-center gap-3 rounded-lg border px-4 py-3"
            style={{
              borderColor: `color-mix(in srgb, var(--sf-${banner.tone}) 30%, transparent)`,
              background: `var(--sf-${banner.tone}-bg)`,
            }}
          >
            <LuTriangleAlert className="size-4 shrink-0" style={{ color: `var(--sf-${banner.tone})` }} aria-hidden />
            <span className="text-[13px] text-[var(--sf-text-1)]">{banner.text}</span>
          </div>
        ) : null}
        {exportError ? (
          <p className="px-5 pt-3 text-xs text-[var(--sf-fail)]" role="alert">
            {exportError}
          </p>
        ) : null}
        {activeTab === "overview" ? (
          <OverviewTab
            run={run}
            rows={rows}
            previousRun={previous}
            onOpenCase={(id) => openCase(id)}
            onTag={(tag) => showCases(filterWithTag(tag))}
            onAllCases={() => showCases(EMPTY_FILTER)}
          />
        ) : null}
        {activeTab === "cases" ? (
          <CasesTab
            run={run}
            filter={filter}
            onFilter={setFilter}
            vocabulary={failureTypes.items}
            allRows={rows}
            onOpen={(id) => openCase(id)}
          />
        ) : null}
        {activeTab === "graders" ? (
          <GradersTab run={run} onOpenCase={openCase} onShowFailing={(id) => showCases(filterWithGrader(id))} />
        ) : null}
        {activeTab === "config" ? (
          <ConfigTab
            run={run}
            previousRun={previous}
            onCompare={() => previous !== null && navigate(evalComparePath(evalId, { a: previous, b: runNumber }))}
            onRerun={() => void rerun()}
            rerunBusy={rerunBusy}
            rerunError={rerunError}
          />
        ) : null}
      </div>
      <footer className="flex h-10 shrink-0 items-center justify-between border-t border-[var(--sf-hairline)] px-5 text-xs text-[var(--sf-text-3)]">
        <span>{footerText(run)}</span>
        <span className="flex items-center gap-2">
          <button
            type="button"
            aria-label="Previous run"
            disabled={position.previous === null}
            onClick={() => position.previous !== null && navigate(evalRunPath(evalId, position.previous, { tab: activeTab }))}
            className="disabled:opacity-30"
          >
            <LuChevronLeft className="size-4" aria-hidden />
          </button>
          <span className={MONO_CLASS}>{position.label}</span>
          <button
            type="button"
            aria-label="Next run"
            disabled={position.next === null}
            onClick={() => position.next !== null && navigate(evalRunPath(evalId, position.next, { tab: activeTab }))}
            className="disabled:opacity-30"
          >
            <LuChevronRight className="size-4" aria-hidden />
          </button>
        </span>
      </footer>
      {caseId !== undefined ? (
        <CaseDrawer
          run={run}
          caseId={caseId}
          repeat={repeat}
          drawerTab={drawerTab}
          caseIds={caseIds}
          flaky={flakySet.has(caseId)}
          vocabulary={failureTypes.items}
          onVocabularyChanged={failureTypes.reload}
          onClose={closeDrawer}
          onOpenCase={(id) => openCase(id)}
          onRepeat={(i) => openCase(caseId, i)}
          onReviewSaved={() => {
            fetchEvalRunByNumber(evalId, runNumber).then(setFresh, () => undefined);
          }}
        />
      ) : null}
    </div>
  );
}
