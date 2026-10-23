import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LuCode, LuLayoutList, LuPlay } from "react-icons/lu";
import { EvalApiError, fetchEval, updateEval, validateEval } from "../../../api/evalsClient";
import type { EvalDefinition, EvalDetail } from "../../../api/evalTypes";
import type { ValidationFinding } from "../../../api/types";
import { evalEditPath, evalRunPath, evalsPath, navigate } from "../../../routes";
import { showToast } from "../../../toast";
import { PageHeader } from "../../shell/PageHeader";
import { BTN, BTN_PRIMARY, TEXTAREA } from "../datasets/DialogShell";
import { ConversationCard } from "../newEval/ConversationCard";
import { GradersList } from "../newEval/GradersStep";
import { useAgentTargets } from "../newEval/useAgentTargets";
import { CARD, FindingsList, MONO } from "../newEval/parts";
import { useWizardData } from "../newEval/useWizardData";
import type { GradersDraft } from "../newEval/wizardModel";
import { openRunDialog } from "../run/runDialogStore";
import { DefinitionCard } from "./DefinitionCard";
import { DiffPanel } from "./DiffPanel";
import { ChangeAgentDialog, ChangeDatasetDialog, ChangeTargetDialog, ConfirmDialog } from "./EditDialogs";
import {
  BLOCKED_SAVE_REASON,
  EXTERNAL_BANNER_TITLE,
  FILE_CHANGED_TITLE,
  NO_RUNS_BANNER,
  afterSave,
  buildSaveBody,
  conversationDraftOf,
  definitionProblems,
  discard,
  discardNeedsConfirm,
  errorsOf,
  evalDirOf,
  footerNote,
  isDirty,
  isAgentDefinition,
  isFileChangedError,
  keepEditing,
  loadState,
  onFileChanged,
  onFocusFetched,
  reloadFromDisk,
  resolveRelative,
  saveBlockReason,
  setDraft as setDraftIn,
  setYamlText,
  shouldBlockLeave,
  sameFile,
  switchToForm,
  switchToYaml,
  targetFromDefinition,
  unsavedCount,
  unsavedLabel,
  withAgentTarget,
  withConversationDraft,
  withDatasetFile,
  withTarget,
  type EditState,
} from "./editModel";
import { useEditPreview } from "./useEditPreview";

const FALLBACK = { repeats: 3, passThreshold: 0.8, maxCostUsd: 2 };

function ModeToggle({ mode, busy, onChange }: { mode: "form" | "yaml"; busy: boolean; onChange: (m: "form" | "yaml") => void }) {
  const item = (value: "form" | "yaml", label: string, Icon: typeof LuCode) => (
    <button
      type="button"
      role="radio"
      aria-checked={mode === value}
      disabled={busy}
      onClick={() => value !== mode && onChange(value)}
      className={`flex h-7 items-center gap-1.5 rounded-md px-3 text-[13px] ${mode === value ? "bg-[var(--sf-raised)] text-[var(--sf-text-1)]" : "text-[var(--sf-text-3)]"}`}
    >
      <Icon className="size-3.5" aria-hidden /> {label}
    </button>
  );
  return (
    <div role="radiogroup" aria-label="Edit mode" className="flex rounded-lg border border-[var(--sf-hairline-strong)] p-0.5">
      {item("form", "Form", LuLayoutList)}
      {item("yaml", "YAML", LuCode)}
    </div>
  );
}

function Banner({ tone, children, actions }: { tone: "needs" | "fail" | "muted"; children: React.ReactNode; actions?: React.ReactNode }) {
  const style =
    tone === "muted"
      ? undefined
      : { borderColor: `color-mix(in srgb, var(--sf-${tone}) 30%, transparent)`, background: `var(--sf-${tone}-bg)` };
  return (
    <div role="alert" className={`flex items-center gap-3 rounded-lg border px-4 py-3 text-[13px] ${tone === "muted" ? "border-[var(--sf-hairline)] bg-[var(--sf-panel)] text-[var(--sf-text-2)]" : "text-[var(--sf-text-1)]"}`} style={style}>
      <span className="min-w-0 flex-1">{children}</span>
      {actions}
    </div>
  );
}

type Dialog = null | "target" | "dataset" | "discard" | "conflict" | "leave";

export function EditEvalPage({ evalId }: { evalId: string }) {
  const [detail, setDetail] = useState<EvalDetail | null>(null);
  const [state, setState] = useState<EditState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [saving, setSaving] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [saveError, setSaveError] = useState<{ message: string; findings: ValidationFinding[] } | null>(null);
  const [switchFindings, setSwitchFindings] = useState<ValidationFinding[] | null>(null);
  const data = useWizardData();
  const preview = useEditPreview(state);
  const isAgent = isAgentDefinition(state?.draft);
  const agents = useAgentTargets(isAgent);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setState(null);
    setLoadError(null);
    fetchEval(evalId).then(
      (d) => {
        if (cancelled) return;
        setDetail(d);
        setState(loadState(d));
      },
      (err) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [evalId]);

  const yamlDefinition = state?.mode === "yaml" ? preview.definition : null;
  const dirty = state !== null && isDirty(state, yamlDefinition);
  const count = state ? unsavedCount(state, yamlDefinition) : 0;

  const stateRef = useRef(state);
  stateRef.current = state;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  // Re-fetch the file when the page regains focus.
  useEffect(() => {
    async function check() {
      const current = stateRef.current;
      if (!current || document.visibilityState === "hidden") return;
      try {
        const fresh = await fetchEval(evalId);
        const latest = stateRef.current;
        if (!latest) return;
        const out = onFocusFetched(latest, fresh, dirtyRef.current);
        if (out.state !== latest) {
          setState(out.state);
          setDetail(fresh);
        }
      } catch {
        /* a failed re-check changes nothing */
      }
    }
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    return () => {
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", check);
    };
  }, [evalId]);

  // Leaving the page with unsaved changes.
  const pendingHash = useRef<string | null>(null);
  const lastHash = useRef(window.location.hash);
  const leaving = useRef(false);
  useEffect(() => {
    function onHash() {
      const next = window.location.hash;
      if (!leaving.current && shouldBlockLeave(dirtyRef.current, evalId, next)) {
        pendingHash.current = next;
        window.history.replaceState(null, "", lastHash.current);
        window.dispatchEvent(new HashChangeEvent("hashchange"));
        setDialog("leave");
        return;
      }
      lastHash.current = next;
    }
    function onBeforeUnload(e: BeforeUnloadEvent) {
      if (dirtyRef.current && !leaving.current) e.preventDefault();
    }
    window.addEventListener("hashchange", onHash);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("hashchange", onHash);
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [evalId]);

  const evalDir = detail ? evalDirOf(detail.path) : ".";
  const judgeModels = useMemo(() => data.models.filter((m) => m.judge_capable !== false).map((m) => m.id), [data.models]);
  const currentTarget = useMemo(() => (state?.draft ? targetFromDefinition(data.rows, state.draft, evalDir) : null), [data.rows, state?.draft, evalDir]);
  const dataset = useMemo(() => (state?.draft ? data.datasets.find((d) => sameFile(d.path, resolveRelative(evalDir, state.draft!.dataset))) : undefined), [data.datasets, state?.draft, evalDir]);

  const change = useCallback((next: (d: EvalDefinition) => EvalDefinition) => {
    setSaveError(null);
    setState((s) => (s ? setDraftIn(s, next) : s));
  }, []);

  const findings = preview.findings;
  const errors = errorsOf(findings);
  const localProblems = state?.mode === "form" && state.draft ? definitionProblems(state.draft, FALLBACK).length : 0;
  const blockReason = state
    ? saveBlockReason(state, { dirty, errors: errors.length, localProblems, saving, validating: preview.loading })
    : "Loading…";

  async function changeMode(mode: "form" | "yaml") {
    if (!state) return;
    setSwitching(true);
    setSwitchFindings(null);
    try {
      if (mode === "yaml") {
        const res = state.draft ? await validateEval({ definition: state.draft }) : null;
        setState((s) => (s ? switchToYaml(s, res?.derived_yaml ?? "") : s));
      } else {
        const res = await validateEval({ yaml: state.yamlText });
        const out = switchToForm(state, res);
        if (out.ok) setState(out.state);
        else setSwitchFindings(out.findings);
      }
    } catch (err) {
      setSwitchFindings([{ severity: "error", code: "eval.validate_failed", path: "", message: err instanceof Error ? err.message : String(err), category: "eval" }]);
    } finally {
      setSwitching(false);
    }
  }

  async function save() {
    if (!state || blockReason !== null) return;
    const body = buildSaveBody(state);
    if (!body) return;
    setSaving(true);
    setSaveError(null);
    try {
      const saved = await updateEval(evalId, body);
      setDetail(saved);
      setState(afterSave(state, saved));
      showToast("Saved");
    } catch (err) {
      if (isFileChangedError(err)) {
        setState((s) => (s ? onFileChanged(s) : s));
        setDialog("conflict");
      } else if (err instanceof EvalApiError) {
        setSaveError({ message: err.message, findings: err.findings ?? [] });
      } else {
        setSaveError({ message: err instanceof Error ? err.message : String(err), findings: [] });
      }
    } finally {
      setSaving(false);
    }
  }

  async function reload() {
    try {
      const fresh = await fetchEval(evalId);
      setDetail(fresh);
      setState((s) => (s ? reloadFromDisk(s, fresh) : s));
      setDialog(null);
      setSwitchFindings(null);
      setSaveError(null);
    } catch (err) {
      setSaveError({ message: err instanceof Error ? err.message : String(err), findings: [] });
      setDialog(null);
    }
  }

  function keep() {
    setState((s) => (s ? keepEditing(s) : s));
    setDialog(null);
  }

  function requestDiscard() {
    if (!state) return;
    if (discardNeedsConfirm(dirty)) setDialog("discard");
    else setState(discard(state));
  }

  function leave() {
    const to = pendingHash.current;
    leaving.current = true;
    pendingHash.current = null;
    setDialog(null);
    if (to) navigate(to);
  }

  const crumbs = [{ label: "Evals", onClick: () => navigate(evalsPath()) }];
  if (loadError) {
    return (
      <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-[var(--sf-ground)]">
        <PageHeader title="Edit eval" crumbs={crumbs} />
        <p role="alert" className="px-5 py-4 text-[13px] text-[var(--sf-fail)]">{loadError}</p>
      </div>
    );
  }
  if (!state || !detail) {
    return (
      <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-[var(--sf-ground)]">
        <PageHeader title="Edit eval" crumbs={crumbs} />
        <p className="px-5 py-4 text-xs text-[var(--sf-text-3)]">Loading…</p>
      </div>
    );
  }

  const label = unsavedLabel(dirty ? count : 0);
  const draft = state.draft;
  const gradersView: GradersDraft | null = draft ? { graders: draft.graders, budget: draft.budget } : null;

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-[var(--sf-ground)]">
      <PageHeader
        title="Edit eval"
        subtitle={`Everything in ${detail.path} can be changed here. The form and the YAML stay in sync.`}
        crumbs={[...crumbs, { label: evalId, onClick: () => navigate(evalEditPath(evalId)) }]}
        titleAddon={
          detail.active_run ? (
            <button
              type="button"
              onClick={() => navigate(evalRunPath(evalId, detail.active_run!.run_number))}
              className="flex items-center gap-1.5 rounded-md bg-[var(--sf-running-bg)] px-2 py-0.5 text-xs text-[var(--sf-running)] hover:underline"
            >
              <span className="block size-1.5 animate-pulse rounded-full bg-[var(--sf-running)]" />
              Run in progress
            </button>
          ) : null
        }
        actions={
          <>
            {label ? <span className="rounded-md bg-[var(--sf-needs-bg)] px-2 py-1 text-xs text-[var(--sf-needs)]">{label}</span> : null}
            <ModeToggle mode={state.mode} busy={switching} onChange={(m) => void changeMode(m)} />
            {detail.runs_count > 0 ? (
              <button type="button" className={BTN} onClick={() => openRunDialog(evalId)}>
                <LuPlay className="size-3.5" aria-hidden /> Run
              </button>
            ) : null}
          </>
        }
      />
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-7 py-5">
        {detail.runs_count === 0 ? (
          <Banner
            tone="muted"
            actions={
              <button type="button" className={BTN} onClick={() => openRunDialog(evalId)}>
                <LuPlay className="size-3.5" aria-hidden /> Run
              </button>
            }
          >
            {NO_RUNS_BANNER}
          </Banner>
        ) : null}
        {state.externalChange ? (
          <Banner
            tone="needs"
            actions={
              <>
                <button type="button" className={BTN} onClick={keep}>Keep editing</button>
                <button type="button" className={BTN_PRIMARY} onClick={() => void reload()}>Reload from disk</button>
              </>
            }
          >
            <strong>{EXTERNAL_BANNER_TITLE}</strong> since you opened it. Reloading discards your unsaved changes.
          </Banner>
        ) : null}
        {state.conflict === "blocked" ? (
          <Banner tone="needs" actions={<button type="button" className={BTN_PRIMARY} onClick={() => void reload()}>Reload from disk</button>}>
            {BLOCKED_SAVE_REASON}: the file changed on disk, so saving is off until you reload.
          </Banner>
        ) : null}
        {saveError ? (
          <Banner tone="fail">
            {saveError.message}
            {saveError.findings.length > 0 ? <FindingsList findings={saveError.findings} /> : null}
          </Banner>
        ) : null}

        {state.mode === "form" && draft && gradersView ? (
          <div className="grid grid-cols-[minmax(0,1fr)_360px] gap-6">
            <div className="flex min-w-0 flex-col gap-4">
              <DefinitionCard
                definition={draft}
                judgeModels={judgeModels}
                targetModel={detail.target_model ?? detail.agent?.model ?? currentTarget?.model ?? null}
                agent={detail.agent ? { name: detail.agent.name, revision: detail.agent.revision } : null}
                datasetLabel={dataset ? `${dataset.id} · ${dataset.cases} ${dataset.cases === 1 ? "case" : "cases"}` : draft.dataset}
                onChange={change}
                onChangeTarget={() => setDialog("target")}
                onChangeDataset={() => setDialog("dataset")}
              />
              {isAgent ? (
                <ConversationCard
                  value={conversationDraftOf(draft)}
                  onChange={(next) => change((d) => withConversationDraft(d, next))}
                  agentTools={detail.agent?.tools ?? []}
                  judgeModels={judgeModels}
                />
              ) : null}
              <GradersList
                target={isAgent ? "agent" : "stage"}
                agentToolIds={(detail.agent?.tools ?? []).map((t) => t.id)}
                draft={gradersView}
                judgeModels={judgeModels}
                judgeDefault={draft.defaults?.judge ?? detail.judge_default ?? null}
                setDraft={(next) => {
                  change((d) => {
                    const view: GradersDraft = { graders: d.graders, budget: d.budget };
                    const out = typeof next === "function" ? next(view) : next;
                    const { budget: _b, ...rest } = d;
                    void _b;
                    const hasBudget = out.budget !== undefined && Object.keys(out.budget).length > 0;
                    return { ...rest, graders: out.graders, ...(hasBudget ? { budget: out.budget } : {}) } as EvalDefinition;
                  });
                }}
              />
            </div>
            <aside className="flex min-w-0 flex-col gap-3">
              <DiffPanel fileText={state.fileText} derivedYaml={preview.yaml} findings={findings} loading={preview.loading} />
              {preview.error ? <p role="alert" className="text-xs text-[var(--sf-fail)]">{preview.error}</p> : null}
            </aside>
          </div>
        ) : (
          <div className="grid grid-cols-[minmax(0,1fr)_360px] gap-6">
            <div className="flex min-w-0 flex-col gap-3">
              <section className={`${CARD} overflow-hidden`} aria-label="YAML">
                <header className="flex items-center justify-between border-b border-b-[var(--sf-hairline)] px-3.5 py-2.5">
                  <span className={`${MONO} text-xs text-[var(--sf-text-1)]`}>{detail.path}</span>
                  <span className={`${MONO} rounded bg-[var(--sf-raised)] px-1.5 text-[11px] text-[var(--sf-text-3)]`}>{preview.loading ? "checking…" : "YAML"}</span>
                </header>
                <textarea
                  className={`${TEXTAREA} ${MONO} block min-h-[480px] resize-y rounded-none border-0 bg-transparent leading-[1.6]`}
                  value={state.yamlText}
                  spellCheck={false}
                  aria-label="Eval YAML"
                  onChange={(e) => {
                    setSaveError(null);
                    setSwitchFindings(null);
                    setState((s) => (s ? setYamlText(s, e.target.value) : s));
                  }}
                />
              </section>
              <YamlErrors findings={switchFindings ?? errors} />
            </div>
            <aside className="flex min-w-0 flex-col gap-3">
              <DiffPanel fileText={state.fileText} derivedYaml={preview.yaml} findings={findings.filter((f) => f.severity === "warning")} loading={preview.loading} />
              {preview.error ? <p role="alert" className="text-xs text-[var(--sf-fail)]">{preview.error}</p> : null}
            </aside>
          </div>
        )}
      </div>

      <footer className="flex shrink-0 items-center justify-between gap-4 border-t border-t-[var(--sf-hairline)] px-7 py-3">
        <p className="min-w-0 text-[13px] text-[var(--sf-text-3)]">{footerNote(detail.path, detail.runs_count)}</p>
        <div className="flex shrink-0 items-center gap-2">
          <button type="button" className={BTN} disabled={!dirty || saving} onClick={requestDiscard}>Discard changes</button>
          <button type="button" className={BTN_PRIMARY} disabled={blockReason !== null} title={blockReason && blockReason !== "No changes to save" ? blockReason : undefined} onClick={() => void save()}>
            {saving ? "Saving…" : "Save eval"}
          </button>
        </div>
      </footer>

      {dialog === "target" && draft && isAgent ? (
        <ChangeAgentDialog
          items={agents.items}
          loading={agents.loading}
          error={agents.error}
          currentAgent={draft.target.kind === "agent" ? draft.target.agent : null}
          onRetry={agents.reload}
          onClose={() => setDialog(null)}
          onConfirm={(a) => {
            change((d) => withAgentTarget(d, a.id));
            setDialog(null);
          }}
        />
      ) : null}
      {dialog === "target" && draft && !isAgent ? (
        <ChangeTargetDialog
          rows={data.rows}
          evals={data.evals}
          loading={data.loading}
          error={data.error}
          current={currentTarget}
          onClose={() => setDialog(null)}
          onConfirm={(t) => {
            change((d) => withTarget(d, t, evalDir));
            setDialog(null);
          }}
        />
      ) : null}
      {dialog === "dataset" && draft ? (
        <ChangeDatasetDialog
          datasets={data.datasets}
          evalDir={evalDir}
          currentDataset={draft.dataset}
          loading={data.loading}
          onClose={() => setDialog(null)}
          onConfirm={(ds) => {
            change((d) => withDatasetFile(d, evalDir, ds.path));
            setDialog(null);
          }}
        />
      ) : null}
      {dialog === "discard" ? (
        <ConfirmDialog
          title="Discard changes?"
          body="Your unsaved changes will be lost and the form returns to the saved file."
          confirmLabel="Discard changes"
          cancelLabel="Keep editing"
          onCancel={() => setDialog(null)}
          onConfirm={() => {
            setState((s) => (s ? discard(s) : s));
            setSwitchFindings(null);
            setSaveError(null);
            setDialog(null);
          }}
        />
      ) : null}
      {dialog === "conflict" ? (
        <ConfirmDialog
          title={FILE_CHANGED_TITLE}
          body="Reloading replaces your draft with the file on disk. Keep editing leaves your draft as it is, but you cannot save it until you reload."
          confirmLabel="Reload from disk"
          cancelLabel="Keep editing"
          onCancel={keep}
          onConfirm={() => void reload()}
        />
      ) : null}
      {dialog === "leave" ? (
        <ConfirmDialog
          title="Leave without saving?"
          body="You have unsaved changes to this eval. Leaving discards them."
          confirmLabel="Leave"
          cancelLabel="Stay"
          onCancel={() => {
            pendingHash.current = null;
            setDialog(null);
          }}
          onConfirm={leave}
        />
      ) : null}
    </div>
  );
}

function YamlErrors({ findings }: { findings: readonly ValidationFinding[] }) {
  if (findings.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1.5 text-[13px]" aria-label="YAML errors">
      {findings.map((f, i) => (
        <li key={i} className="text-[var(--sf-fail)]">
          {f.line !== undefined ? <span className={`${MONO} mr-2 text-xs`}>line {f.line}{f.column !== undefined ? `:${f.column}` : ""}</span> : null}
          {f.message}
        </li>
      ))}
    </ul>
  );
}
