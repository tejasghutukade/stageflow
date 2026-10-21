import { useMemo, useState } from "react";
import { LuArrowRight } from "react-icons/lu";
import { evalCasePath, evalComparePath, evalRunPath, evalsPath, navigate } from "../../../routes";
import { PageHeader } from "../../shell/PageHeader";
import { openRunDialog } from "../run/runDialogStore";
import {
  ByGrader,
  CasesChanged,
  CompareFooter,
  ConstantStrip,
  KpiStrip,
  Notice,
  RunPicker,
  StageDiffPanel,
  StageUnchanged,
} from "./CompareParts";
import {
  EMPTY_STATE_TEXT,
  buildCaseRows,
  buildGraderRows,
  buildKpiTiles,
  buildStageDiff,
  buildStrip,
  caseCounts,
  configChip,
  footerNote,
  stageIdOf,
  type CaseTab,
} from "./compareModel";
import { useCompareData } from "./useCompareData";

export function ComparePage({ evalId, a, b }: { evalId: string; a?: number; b?: number }) {
  const data = useCompareData(evalId, a, b);
  const [tab, setTab] = useState<CaseTab>("fixed");
  const [expanded, setExpanded] = useState(false);

  const view = useMemo(() => {
    if (data.status !== "ready") return null;
    const { result, runB, cases } = data;
    return {
      tiles: buildKpiTiles(result),
      strip: buildStrip(result),
      graders: buildGraderRows(result),
      counts: caseCounts(result.cases),
      rows: buildCaseRows(result.cases, tab, cases),
      chip: configChip(result),
      note: footerNote(result),
      stage: buildStageDiff(result, stageIdOf(runB), expanded),
    };
  }, [data, tab, expanded]);

  const go = (next: { a: number; b: number }) => navigate(evalComparePath(evalId, next));

  const pickers =
    data.status === "ready" ? (
      <>
        <RunPicker label="Before" value={data.selection.a} options={data.options} onChange={(n) => go({ a: n, b: data.selection.b })} />
        <LuArrowRight className="size-4 shrink-0 text-[var(--sf-text-2)]" aria-hidden />
        <RunPicker label="After" value={data.selection.b} options={data.options} onChange={(n) => go({ a: data.selection.a, b: n })} />
      </>
    ) : null;

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-[var(--sf-ground)]">
      <PageHeader
        title="Compare runs"
        subtitle="See what changed in the stage and what that did to the results."
        crumbs={[
          { label: "Evals", onClick: () => navigate(evalsPath()) },
          { label: evalId, onClick: () => navigate(evalRunPath(evalId, data.status === "ready" ? data.selection.b : 1)) },
        ]}
      >
        {pickers}
      </PageHeader>
      <div className="flex min-h-0 flex-1 flex-col overflow-auto">
        {data.status === "loading" ? <Notice>Loading…</Notice> : null}
        {data.status === "error" ? <Notice tone="fail">{data.message}</Notice> : null}
        {data.status === "empty" ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 px-5 py-12">
            <p className="text-[13px] text-[var(--sf-text-2)]">{EMPTY_STATE_TEXT}</p>
            <button
              type="button"
              onClick={() => openRunDialog(evalId)}
              className="flex h-8 items-center rounded-lg border border-[var(--sf-hairline-strong)] px-3 text-[13px] font-medium text-[var(--sf-text-1)]"
            >
              Run the eval
            </button>
          </div>
        ) : null}
        {data.status === "ready" && view ? (
          <>
            <div className="flex flex-col gap-4 px-5 py-4">
              {view.stage ? (
                <StageDiffPanel model={view.stage} expanded={expanded} onToggle={() => setExpanded((v) => !v)} />
              ) : (
                <StageUnchanged />
              )}
              <ConstantStrip strip={view.strip} />
              <KpiStrip tiles={view.tiles} />
              <ByGrader rows={view.graders} />
              <CasesChanged
                counts={view.counts}
                tab={tab}
                onTab={setTab}
                rows={view.rows}
                onOpen={(caseId) => navigate(evalCasePath(evalId, data.runB.run_number, caseId))}
              />
            </div>
            <CompareFooter note={view.note} chip={view.chip.text} amber={view.chip.amber} />
          </>
        ) : null}
      </div>
    </div>
  );
}
