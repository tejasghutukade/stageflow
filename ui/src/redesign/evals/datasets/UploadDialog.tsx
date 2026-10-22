import { useEffect, useMemo, useRef, useState } from "react";
import { LuCheck, LuCircleAlert, LuFileText } from "react-icons/lu";
import { previewEvalDataset } from "../../../api/evalsClient";
import type { EvalDatasetFormat, EvalDatasetPreview, EvalDatasetTarget } from "../../../api/evalTypes";
import { BTN, BTN_PRIMARY, DialogShell, LABEL, MONO, TEXTAREA } from "./DialogShell";
import {
  DELIMITERS,
  DROP_LABEL,
  EXTRAS_TITLE,
  FREE_MODE_HINT,
  FREE_MODE_NOTE,
  SPLIT_OPTIONS,
  autoMatch,
  buildFullMapping,
  buildPreviewRequest,
  canConfirm,
  checkUploadFile,
  casesForImport,
  cellsByColumn,
  confirmLabel,
  defaultDelimiter,
  detectPastedFormat,
  dragDepth,
  firstFile,
  extraColumns,
  extraConflicts,
  formatBytes,
  freeFields,
  hasTarget,
  isFileDrag,
  initExtras,
  modeLabels,
  patchExtra,
  previewRows,
  readyCases,
  rowsFoundText,
  setColumn,
  setSplit,
  stageFields,
  summarize,
  type ExtraChoice,
  type ExtraState,
  type MappingState,
  type UploadConfirm,
  type UploadField,
  type UploadMode,
} from "./uploadModel";

export type { UploadConfirm, UploadMode } from "./uploadModel";

export type UploadDialogProps = {
  open: boolean;
  title?: string;
  subtitle?: string;
  /** The stage cases must fit. Without one the dialog is in free mode: "Pick fields to import". */
  target?: EvalDatasetTarget;
  /** The stage's `io.input.schema` top-level properties (from `EvalDatasetDetail.input_fields`). */
  inputFields?: Array<{ name: string; required: boolean }>;
  /** Names of `expected.<name>` rows for reference graders. */
  expectedFields?: string[];
  /** Cases already in the dataset. Enables the append/replace choice; omit for a new dataset. */
  existingCases?: Array<{ id: string }>;
  projectRoot?: string;
  /** Start with the paste box instead of the file picker. */
  initialMode?: "file" | "paste";
  onClose: () => void;
  /** Called with the ready rows. The dialog does not write anything itself; it stays open until this settles. */
  onConfirm: (request: UploadConfirm) => void | Promise<void>;
};

type Source = { fileName: string; content: string; size: number; format: EvalDatasetFormat };

export function UploadDialog(props: UploadDialogProps) {
  if (!props.open) return null;
  return <UploadDialogBody {...props} />;
}

function UploadDialogBody({
  title = "Upload cases",
  subtitle,
  target,
  inputFields = [],
  expectedFields = [],
  existingCases,
  projectRoot,
  initialMode = "file",
  onClose,
  onConfirm,
}: UploadDialogProps) {
  const [source, setSource] = useState<Source | null>(null);
  const [pasting, setPasting] = useState(initialMode === "paste");
  const [pasteText, setPasteText] = useState("");
  const [delimiter, setDelimiter] = useState(",");
  const [columns, setColumns] = useState<string[] | null>(null);
  const [rowsFound, setRowsFound] = useState(0);
  const [mapping, setMapping] = useState<MappingState>({});
  const [extras, setExtras] = useState<ExtraState>({});
  const [preview, setPreview] = useState<EvalDatasetPreview | null>(null);
  const [mode, setMode] = useState<UploadMode>("append");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [depth, setDepth] = useState(0);
  const parseSeq = useRef(0);
  const previewSeq = useRef(0);
  const [parsed, setParsed] = useState(false);

  const stageAware = hasTarget(target) && inputFields.length > 0;
  const tabular = columns !== null;
  const fields: UploadField[] = useMemo(() => {
    if (!tabular) return [];
    return stageAware ? stageFields(inputFields, expectedFields) : freeFields(columns ?? []);
  }, [tabular, stageAware, inputFields, expectedFields, columns]);
  const extraCols = useMemo(
    () => (tabular && stageAware ? extraColumns(columns ?? [], fields, mapping) : []),
    [tabular, stageAware, columns, fields, mapping],
  );
  const extraClashes = useMemo(
    () =>
      extraConflicts(
        extras,
        extraCols,
        fields.filter((f) => f.role === "expected").map((f) => f.name.replace(/^expected\./, "")),
      ),
    [extras, extraCols, fields],
  );
  const existing = existingCases?.length ?? 0;
  const hasExisting = existingCases !== undefined && existing > 0;

  useEffect(() => {
    if (!source) return;
    const mine = ++parseSeq.current;
    setLoading(true);
    setParsed(false);
    setError(null);
    setPreview(null);
    previewEvalDataset(
      buildPreviewRequest({ format: source.format, content: source.content, delimiter, projectRoot }),
    ).then(
      (res) => {
        if (mine !== parseSeq.current) return;
        setColumns(res.columns ?? null);
        setRowsFound(res.rows.length);
        const names = res.columns ?? [];
        const f = stageAware ? stageFields(inputFields, expectedFields) : freeFields(names);
        setMapping(res.columns ? autoMatch(f, names) : {});
        setExtras(res.columns ? initExtras(names, cellsByColumn(res.rows, names)) : {});
        setLoading(false);
        setParsed(true);
      },
      (err: unknown) => {
        if (mine !== parseSeq.current) return;
        setColumns(null);
        setRowsFound(0);
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, delimiter, projectRoot]);

  useEffect(() => {
    if (!source || !parsed) return;
    const mine = ++previewSeq.current;
    const timer = window.setTimeout(() => {
      setError(null);
      previewEvalDataset(
        buildPreviewRequest({
          format: source.format,
          content: source.content,
          delimiter,
          ...(tabular
            ? { mapping: buildFullMapping(fields, mapping, stageAware ? extras : null, columns ?? []) }
            : {}),
          ...(stageAware && target ? { target } : {}),
          projectRoot,
        }),
      ).then(
        (res) => {
          if (mine === previewSeq.current) setPreview(res);
        },
        (err: unknown) => {
          if (mine === previewSeq.current) setError(err instanceof Error ? err.message : String(err));
        },
      );
    }, 250);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, parsed, mapping, extras, delimiter]);

  async function pickFile(file: File | undefined) {
    if (!file) return;
    const checked = checkUploadFile(file);
    if ("error" in checked) {
      setError(checked.error);
      return;
    }
    const { format } = checked;
    const content = await file.text();
    setDelimiter(defaultDelimiter(file.name));
    setColumns(null);
    setSource({ fileName: file.name, content, size: file.size, format });
  }

  function usePasted() {
    const format = detectPastedFormat(pasteText);
    if (!format) {
      setError("Paste JSONL (one object per line) or CSV with a header row.");
      return;
    }
    setDelimiter(",");
    setColumns(null);
    setSource({ fileName: "pasted text", content: pasteText, size: new Blob([pasteText]).size, format });
  }

  function reset() {
    parseSeq.current += 1;
    previewSeq.current += 1;
    setParsed(false);
    setSource(null);
    setColumns(null);
    setPreview(null);
    setError(null);
    setLoading(false);
  }

  async function confirm() {
    if (!source || !preview) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm({
        mode: hasExisting ? mode : "replace",
        cases: casesForImport(readyCases(preview), {
          format: source.format,
          mode: hasExisting ? mode : "replace",
          existingIds: (existingCases ?? []).map((c) => c.id),
        }),
        ready: preview.counts.ready,
        skipped: preview.counts.skipped,
        fileName: source.fileName,
        format: source.format,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const rows = previewRows(preview, stageAware ? inputFields.map((f) => f.name) : []);
  const summary = summarize(preview);
  const skipped = preview?.counts.skipped ?? 0;
  const labels = modeLabels(existing);

  return (
    <DialogShell
      title={title}
      subtitle={subtitle ?? (stageAware ? "Cases must fit the stage's input" : FREE_MODE_HINT)}
      onClose={onClose}
      footer={
        <>
          <span className="flex min-w-0 items-center gap-2 text-xs text-[var(--sf-text-2)]">
            {error ? (
              <span role="alert" className="text-[var(--sf-fail)]">{error}</span>
            ) : summary ? (
              <>
                {skipped > 0 ? <LuCircleAlert className="size-3.5 shrink-0 text-[var(--sf-needs)]" aria-hidden /> : null}
                <span>{summary}</span>
              </>
            ) : null}
          </span>
          <span className="flex shrink-0 items-center gap-2">
            <button type="button" className={BTN} onClick={onClose}>Cancel</button>
            <button
              type="button"
              className={BTN_PRIMARY}
              disabled={!canConfirm(preview, busy)}
              onClick={() => void confirm()}
            >
              {confirmLabel(preview?.counts.ready ?? 0, mode, existing)}
            </button>
          </span>
        </>
      }
    >
      {!source ? (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2" role="tablist" aria-label="Source">
            {(["file", "paste"] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="tab"
                aria-selected={pasting === (m === "paste")}
                onClick={() => setPasting(m === "paste")}
                className={`flex h-7 items-center rounded-md border px-2.5 text-[13px] ${
                  pasting === (m === "paste")
                    ? "border-[var(--sf-hairline-strong)] bg-[var(--sf-raised)] font-medium text-[var(--sf-text-1)]"
                    : "border-transparent text-[var(--sf-text-2)]"
                }`}
              >
                {m === "file" ? "Upload a file" : "Paste or type"}
              </button>
            ))}
          </div>
          {pasting ? (
            <>
              <textarea
                aria-label="Pasted cases"
                rows={10}
                value={pasteText}
                onChange={(e) => setPasteText(e.target.value)}
                placeholder={'{"input":{"diff":"..."}}   or   diff,plan\n"+x",Add filter'}
                className={`${TEXTAREA} ${MONO}`}
              />
              <div className="flex justify-end">
                <button type="button" className={BTN} disabled={pasteText.trim() === ""} onClick={usePasted}>
                  Read rows
                </button>
              </div>
            </>
          ) : (
            <button
              type="button"
              data-testid="upload-drop-zone"
              data-dragging={depth > 0}
              onClick={() => fileRef.current?.click()}
              onDragEnter={(e) => {
                if (!isFileDrag(e.dataTransfer?.types)) return;
                e.preventDefault();
                setDepth((d) => dragDepth(d, "enter"));
              }}
              onDragOver={(e) => {
                if (!isFileDrag(e.dataTransfer?.types)) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "copy";
              }}
              onDragLeave={(e) => {
                if (!isFileDrag(e.dataTransfer?.types)) return;
                setDepth((d) => dragDepth(d, "leave"));
              }}
              onDrop={(e) => {
                if (!isFileDrag(e.dataTransfer?.types)) return;
                e.preventDefault();
                setDepth(dragDepth(0, "reset"));
                void pickFile(firstFile(e.dataTransfer.files));
              }}
              className={`flex h-28 flex-col items-center justify-center gap-1 rounded-lg border border-dashed text-[13px] text-[var(--sf-text-2)] ${
                depth > 0
                  ? "border-[var(--sf-text-1)] bg-[var(--sf-raised)]"
                  : "border-[var(--sf-hairline-strong)]"
              }`}
            >
              {depth > 0 ? (
                <span className="font-medium text-[var(--sf-text-1)]">{DROP_LABEL}</span>
              ) : (
                <>
                  <span className="font-medium text-[var(--sf-text-1)]">Choose a file</span>
                  <span>JSONL, JSON or CSV, up to 50 MB</span>
                </>
              )}
            </button>
          )}
          <input
            ref={fileRef}
            type="file"
            accept=".jsonl,.ndjson,.json,.csv,.tsv"
            className="hidden"
            data-testid="upload-file-input"
            onChange={(e) => {
              void pickFile(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
        </div>
      ) : (
        <>
          <div className="flex items-center gap-3 rounded-lg border border-[var(--sf-hairline)] bg-[var(--sf-ground)] px-3.5 py-2.5">
            <LuFileText className="size-4 shrink-0 text-[var(--sf-text-3)]" aria-hidden />
            <span className={`${MONO} truncate text-[13px] text-[var(--sf-text-1)]`}>{source.fileName}</span>
            <span className="shrink-0 text-xs text-[var(--sf-text-3)]">
              {formatBytes(source.size)}
              {loading ? "" : ` · ${rowsFoundText(rowsFound)}`}
            </span>
            <span className="flex-1" />
            {source.format === "csv" ? (
              <label className="flex items-center gap-2 text-xs text-[var(--sf-text-3)]">
                Delimiter
                <select
                  aria-label="CSV delimiter"
                  value={delimiter}
                  onChange={(e) => setDelimiter(e.target.value)}
                  className="h-7 rounded-md border border-[var(--sf-hairline-strong)] bg-[var(--sf-raised)] px-2 text-xs text-[var(--sf-text-1)]"
                >
                  {DELIMITERS.map((d) => (
                    <option key={d.value} value={d.value}>{d.label}</option>
                  ))}
                </select>
              </label>
            ) : null}
            <button type="button" onClick={reset} className="shrink-0 text-[13px] font-medium text-[var(--sf-text-1)] hover:underline">
              Choose another file
            </button>
          </div>

          {tabular ? (
            <section className="flex flex-col gap-2" aria-label="Column mapping">
              <div className="flex items-baseline justify-between">
                <h3 className={LABEL}>{stageAware ? "Match columns to the stage's input" : FREE_MODE_HINT}</h3>
                <span className="text-xs text-[var(--sf-text-3)]">
                  {stageAware ? "Matched by name where possible" : FREE_MODE_NOTE}
                </span>
              </div>
              <div className="overflow-hidden rounded-lg border border-[var(--sf-hairline)]">
                {fields.map((field) => (
                  <FieldRow
                    key={field.key}
                    field={field}
                    stageAware={stageAware}
                    columns={columns ?? []}
                    choice={mapping[field.key]}
                    onColumn={(c) => setMapping((m) => setColumn(m, field.key, c))}
                    onSplit={(s) => setMapping((m) => setSplit(m, field.key, s))}
                  />
                ))}
              </div>
            </section>
          ) : null}

          {extraCols.length > 0 ? (
            <section className="flex flex-col gap-2" aria-label="Reference data">
              <div className="flex items-baseline justify-between">
                <h3 className={LABEL}>{EXTRAS_TITLE}</h3>
                <span className="text-xs text-[var(--sf-text-3)]">Other columns, imported as expected answers</span>
              </div>
              <div className="overflow-hidden rounded-lg border border-[var(--sf-hairline)]">
                {extraCols.map((column) => (
                  <ExtraRow
                    key={column}
                    column={column}
                    choice={extras[column]}
                    clash={extraClashes.has(column)}
                    onChange={(patch) => setExtras((x) => patchExtra(x, column, patch))}
                  />
                ))}
              </div>
            </section>
          ) : null}

          <section className="flex flex-col gap-2" aria-label="Preview">
            <h3 className={LABEL}>Preview</h3>
            <div className="overflow-hidden rounded-lg border border-[var(--sf-hairline)]">
              {rows.length === 0 ? (
                <p className="px-3.5 py-3 text-xs text-[var(--sf-text-3)]">{loading || !preview ? "Reading rows…" : "No rows"}</p>
              ) : (
                rows.map((row) => (
                  <div
                    key={row.index}
                    data-status={row.status}
                    className={`flex items-center gap-3 border-b border-b-[var(--sf-hairline)] px-3.5 py-2 last:border-b-0 ${
                      row.status === "skipped" ? "bg-[var(--sf-needs-bg)]" : ""
                    }`}
                  >
                    <span className="w-4 shrink-0 text-xs text-[var(--sf-text-3)]">{row.index + 1}</span>
                    <span className={`${MONO} min-w-0 flex-1 truncate text-xs text-[var(--sf-text-1)]`}>{row.text}</span>
                    <span
                      className="w-[180px] shrink-0 truncate text-xs text-[var(--sf-text-2)]"
                      style={row.status === "skipped" ? { color: "var(--sf-needs)" } : undefined}
                    >
                      {row.secondary}
                    </span>
                    <span className="flex w-[110px] shrink-0 items-center gap-1.5 text-xs text-[var(--sf-text-2)]" title={row.reason}>
                      <span
                        className="size-1.5 rounded-full"
                        style={{ background: row.status === "ready" ? "var(--sf-ok)" : "var(--sf-needs)" }}
                      />
                      {row.status === "ready" ? "Ready" : "Skipped"}
                    </span>
                  </div>
                ))
              )}
            </div>
          </section>

          {hasExisting ? (
            <fieldset className="flex items-center gap-5" aria-label="Where to add the cases">
              {(["append", "replace"] as const).map((m) => (
                <label key={m} className="flex cursor-pointer items-center gap-2 text-[13px] text-[var(--sf-text-1)]">
                  <input type="radio" name="upload-mode" checked={mode === m} onChange={() => setMode(m)} />
                  {labels[m]}
                </label>
              ))}
            </fieldset>
          ) : null}
        </>
      )}
    </DialogShell>
  );
}

function FieldRow({
  field,
  stageAware,
  columns,
  choice,
  onColumn,
  onSplit,
}: {
  field: UploadField;
  stageAware: boolean;
  columns: string[];
  choice: { column: string | null; split?: string } | undefined;
  onColumn: (column: string | null) => void;
  onSplit: (split: string) => void;
}) {
  const column = choice?.column ?? null;
  if (!stageAware) {
    return (
      <label className="flex cursor-pointer items-center gap-3 border-b border-b-[var(--sf-hairline)] px-3.5 py-2 last:border-b-0">
        <input type="checkbox" checked={column !== null} onChange={(e) => onColumn(e.target.checked ? field.name : null)} />
        <span className={`${MONO} text-[13px] text-[var(--sf-text-1)]`}>{field.name}</span>
      </label>
    );
  }
  return (
    <div className="flex items-center gap-3 border-b border-b-[var(--sf-hairline)] px-3.5 py-2.5 last:border-b-0" data-field={field.key}>
      <span className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className={`${MONO} truncate text-[13px] text-[var(--sf-text-1)]`} title={field.name}>{field.name}</span>
        <span className="shrink-0 text-[11px] text-[var(--sf-text-3)]">{field.kind}</span>
      </span>
      <span className="text-[var(--sf-text-3)]" aria-hidden>←</span>
      <select
        aria-label={`Source column for ${field.name}`}
        value={column ?? ""}
        onChange={(e) => onColumn(e.target.value === "" ? null : e.target.value)}
        className={`${MONO} h-8 w-[190px] shrink-0 rounded-lg border border-[var(--sf-hairline-strong)] bg-[var(--sf-raised)] px-2.5 text-[13px] text-[var(--sf-text-1)] outline-none`}
      >
        <option value="">Do not import</option>
        {columns.map((c) => (
          <option key={c} value={c}>{c}</option>
        ))}
      </select>
      {field.role === "expected" ? (
        <select
          aria-label={`Split character for ${field.name}`}
          value={choice?.split ?? ""}
          onChange={(e) => onSplit(e.target.value)}
          className="h-8 w-[104px] shrink-0 rounded-lg border border-[var(--sf-hairline-strong)] bg-[var(--sf-raised)] px-2 text-xs text-[var(--sf-text-2)]"
        >
          {SPLIT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      ) : null}
      <span className="flex w-4 shrink-0 justify-center">
        {column !== null ? <LuCheck className="size-4 text-[var(--sf-ok)]" aria-label="Mapped" /> : null}
      </span>
    </div>
  );
}

function ExtraRow({
  column,
  choice,
  clash,
  onChange,
}: {
  column: string;
  choice: ExtraChoice | undefined;
  clash: boolean;
  onChange: (patch: Partial<ExtraChoice>) => void;
}) {
  const enabled = choice?.enabled ?? false;
  return (
    <div className="flex items-center gap-3 border-b border-b-[var(--sf-hairline)] px-3.5 py-2.5 last:border-b-0" data-extra={column}>
      <input
        type="checkbox"
        aria-label={`Import ${column} as reference data`}
        checked={enabled}
        onChange={(e) => onChange({ enabled: e.target.checked })}
      />
      <span className={`${MONO} min-w-0 flex-1 truncate text-[13px] text-[var(--sf-text-1)]`} title={column}>{column}</span>
      <span className="text-[var(--sf-text-3)]" aria-hidden>→</span>
      <span className={`${MONO} text-xs text-[var(--sf-text-3)]`}>expected.</span>
      <input
        type="text"
        aria-label={`Key name for ${column}`}
        aria-invalid={enabled && clash}
        disabled={!enabled}
        value={choice?.key ?? ""}
        onChange={(e) => onChange({ key: e.target.value })}
        title={enabled && clash ? "Empty or already used: this column will not be imported" : undefined}
        className={`${MONO} h-8 w-[150px] shrink-0 rounded-lg border bg-[var(--sf-raised)] px-2.5 text-[13px] text-[var(--sf-text-1)] outline-none disabled:opacity-50 ${
          enabled && clash ? "border-[var(--sf-fail)]" : "border-[var(--sf-hairline-strong)]"
        }`}
      />
      <select
        aria-label={`Split character for ${column}`}
        disabled={!enabled}
        value={choice?.split ?? ""}
        onChange={(e) => onChange({ split: e.target.value })}
        className="h-8 w-[104px] shrink-0 rounded-lg border border-[var(--sf-hairline-strong)] bg-[var(--sf-raised)] px-2 text-xs text-[var(--sf-text-2)] disabled:opacity-50"
      >
        {SPLIT_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </div>
  );
}
