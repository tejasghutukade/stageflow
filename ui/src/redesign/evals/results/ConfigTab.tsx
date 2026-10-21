import { useState } from "react";
import { LuCopy, LuDownload, LuFingerprint, LuRefreshCw } from "react-icons/lu";
import type { EvalRunDetail } from "../../../api/evalTypes";
import {
  datasetCard,
  fingerprintNote,
  gradersCard,
  reproduceCommand,
  rerunNote,
  settingsCard,
  stageCard,
  type Chip as ChipModel,
  type ConfigRow,
} from "./configModel";
import { Card, Chip, ButtonLike, MONO_CLASS } from "./ResultsParts";
import { copyText, downloadRunExport } from "./resultsApi";

function Rows({ rows }: { rows: ConfigRow[] }) {
  return (
    <dl>
      {rows.map((row) => (
        <div key={row.label} className="flex items-baseline justify-between gap-4 px-4 py-2 text-[13px]">
          <dt className="shrink-0 text-[var(--sf-text-3)]">{row.label}</dt>
          <dd className={`flex flex-wrap items-center justify-end gap-2 text-right text-[var(--sf-text-1)] ${MONO_CLASS}`}>
            {row.chip ? <Chip tone={row.chip.tone}>{row.chip.text}</Chip> : null}
            {row.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function StatusChip({ chip }: { chip: ChipModel | null }) {
  return chip ? <Chip tone={chip.tone}>{chip.text}</Chip> : null;
}

export function ConfigTab({
  run,
  previousRun,
  onCompare,
  onRerun,
  rerunBusy,
  rerunError,
}: {
  run: EvalRunDetail;
  previousRun: number | null;
  onCompare: () => void;
  onRerun: () => void;
  rerunBusy: boolean;
  rerunError: string | null;
}) {
  const [copied, setCopied] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const dataset = datasetCard(run);
  const graders = gradersCard(run);
  const command = reproduceCommand(run);
  const note = rerunNote(run);

  async function copy() {
    if (await copyText(command)) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }
  }

  return (
    <div className="flex flex-col gap-4 px-5 py-4">
      <div className="flex items-center gap-3 rounded-lg border border-[var(--sf-hairline)] bg-[var(--sf-panel)] px-4 py-3 text-[13px]">
        <LuFingerprint className="size-4 text-[var(--sf-text-3)]" aria-hidden />
        <span className="text-[var(--sf-text-1)]">Config fingerprint</span>
        <span className={`rounded-md border border-[var(--sf-hairline-strong)] px-2 py-0.5 ${MONO_CLASS}`}>{run.fingerprint}</span>
        <span className="flex-1 text-xs text-[var(--sf-text-3)]">{fingerprintNote()}</span>
        {previousRun !== null ? (
          <button type="button" className="text-[var(--sf-text-1)]" onClick={onCompare}>
            Compare with #{previousRun}
          </button>
        ) : null}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="flex flex-col gap-4">
          <Card title="Stage">
            <Rows rows={stageCard(run)} />
          </Card>
          <Card title="Dataset" right={<StatusChip chip={dataset.status} />}>
            <Rows rows={dataset.rows} />
          </Card>
        </div>
        <div className="flex flex-col gap-4">
          <Card title="Graders" addon={graders.summary}>
            <div>
              {graders.rows.map((g) => (
                <div key={g.id} className="flex items-center justify-between gap-3 px-4 py-2 text-[13px]">
                  <span className={`${MONO_CLASS} text-[var(--sf-text-1)]`}>{g.id}</span>
                  <span className={`flex items-center gap-2 text-xs text-[var(--sf-text-3)] ${MONO_CLASS}`}>
                    {g.edited ? <Chip tone="needs">{g.edited.text}</Chip> : null}
                    {g.notCalibrated ? <Chip>Not calibrated</Chip> : null}
                    {g.kind}
                    {g.versionText ? ` ${g.versionText}` : ""} · {g.weightText} · {g.hash}
                  </span>
                </div>
              ))}
            </div>
          </Card>
          <Card title="Run settings">
            <Rows rows={settingsCard(run)} />
          </Card>
        </div>
      </div>

      <section className="flex flex-col gap-3 rounded-lg border border-[var(--sf-hairline)] bg-[var(--sf-panel)] p-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-[var(--sf-text-1)]">Run this exact configuration again</h2>
            <p className={`mt-1 break-all text-xs text-[var(--sf-text-2)] ${MONO_CLASS}`}>{command}</p>
          </div>
          <div className="flex items-center gap-2">
            <ButtonLike onClick={() => void copy()}>
              <LuCopy className="size-3.5" aria-hidden />
              {copied ? "Copied" : "Copy command"}
            </ButtonLike>
            <ButtonLike
              onClick={() => {
                setExportError(null);
                downloadRunExport(run, "config").catch((err) => setExportError(err instanceof Error ? err.message : String(err)));
              }}
            >
              <LuDownload className="size-3.5" aria-hidden />
              Export JSON
            </ButtonLike>
            <ButtonLike primary disabled={rerunBusy} onClick={onRerun}>
              <LuRefreshCw className="size-3.5" aria-hidden />
              Re-run with these settings
            </ButtonLike>
          </div>
        </div>
        {note ? <p className="text-xs text-[var(--sf-needs)]">{note}</p> : null}
        {rerunError ? (
          <p className="text-xs text-[var(--sf-fail)]" role="alert">
            {rerunError}
          </p>
        ) : null}
        {exportError ? (
          <p className="text-xs text-[var(--sf-fail)]" role="alert">
            {exportError}
          </p>
        ) : null}
      </section>
    </div>
  );
}
