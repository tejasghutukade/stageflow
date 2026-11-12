import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LuCheck, LuCopy, LuTrash2, LuTriangleAlert } from "react-icons/lu";
import {
  FunctionApiError,
  functionsApi,
  type FunctionBinding,
  type FunctionCapability,
  type FunctionDefinition,
  type FunctionDetail,
  type FunctionInvocation,
  type FunctionIssue,
  type FunctionKind,
  type FunctionUsage,
} from "../../api/functions";
import { functionPath, functionsPath, navigate } from "../../routes";
import { showToast } from "../../toast";
import { Dialog } from "../agents/editor/Dialogs";
import { MONO, NOWRAP, PAGE_BG } from "../agents/agentsTokens";
import { Button, ChangedDot, Field, FieldMessages, NumberField, PageFooter, SectionHeading, TextBox } from "../agents/ui";
import { PageHeader } from "../shell/PageHeader";
import { FunctionContractFields } from "./FunctionContractFields";
import { FunctionDeclaredAccess } from "./FunctionDeclaredAccess";
import { applyDeclaredControl, contractSnapshot, declaredAccessState, definitionPayload, moveLegacyAccessIntoSource } from "./functionAccessSource";
import { Callout, CodeArea, issuesAt } from "./FunctionFields";
import { FunctionSourceEditor } from "./FunctionSourceEditor";
import { FunctionHistory, FunctionTestPanel } from "./FunctionTestPanel";
import { FUNCTION_KINDS, KIND_META, KindPill, slugId } from "./functionKinds";
import { followToolFields, FUNCTION_TEMPLATES, saveOrSurfaceConflict } from "./functionsPageModel";

type EditorDraft = {
  id: string;
  name: string;
  description: string;
  kind: FunctionKind;
  source: string;
  timeout_ms: number;
  capabilities: FunctionCapability[];
  bindings: FunctionBinding[];
  tool_name: string;
  tool_description: string;
  input_schema: string;
  output_schema: string;
};

type SectionId = "details" | "source" | "contract" | "tool" | "test" | "history";

const SECTION_LABEL: Record<SectionId, string> = {
  details: "Details",
  source: "Source",
  contract: "Access",
  tool: "Tool interface",
  test: "Test",
  history: "History",
};

const domId = (id: SectionId) => `function-section-${id}`;

const DEFAULT_INPUT_SCHEMA = "{\n  \"type\": \"object\",\n  \"properties\": {},\n  \"additionalProperties\": false\n}";

function emptyDraft(kind: FunctionKind = "verification"): EditorDraft {
  return {
    id: "",
    name: "",
    description: "",
    kind,
    source: FUNCTION_TEMPLATES[kind],
    timeout_ms: 5000,
    capabilities: [],
    bindings: [],
    tool_name: "",
    tool_description: "",
    input_schema: DEFAULT_INPUT_SCHEMA,
    output_schema: "",
  };
}

function draftFromDetail(detail: FunctionDetail): EditorDraft {
  const definition = detail.definition;
  return {
    id: detail.id,
    name: definition?.name ?? detail.name ?? "",
    description: definition?.description ?? detail.description ?? "",
    kind: definition?.kind ?? detail.kind ?? "verification",
    source: definition?.source ?? "",
    timeout_ms: definition?.timeout_ms ?? 5000,
    capabilities: definition?.capabilities ?? [],
    bindings: definition?.bindings ?? [],
    tool_name: definition?.tool_name ?? "",
    tool_description: definition?.tool_description ?? "",
    input_schema: definition?.input_schema ? JSON.stringify(definition.input_schema, null, 2) : "",
    output_schema: definition?.output_schema ? JSON.stringify(definition.output_schema, null, 2) : "",
  };
}

function parseSchema(text: string, field: string, issues: FunctionIssue[]): Record<string, unknown> | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try {
    const value = JSON.parse(trimmed) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      issues.push({ path: field, code: "function.schema", message: `${field.replace("_", " ")} must be a JSON object.` });
      return undefined;
    }
    return value as Record<string, unknown>;
  } catch {
    issues.push({ path: field, code: "function.schema", message: `${field.replace("_", " ")} must be valid JSON.` });
    return undefined;
  }
}

function toDefinition(draft: EditorDraft): { definition?: FunctionDefinition; issues: FunctionIssue[] } {
  const issues: FunctionIssue[] = [];
  const definition: FunctionDefinition = {
    id: draft.id.trim(),
    name: draft.name.trim(),
    ...(draft.description.trim() ? { description: draft.description.trim() } : {}),
    kind: draft.kind,
    source: draft.source,
    timeout_ms: draft.timeout_ms,
    capabilities: draft.capabilities,
    bindings: draft.bindings,
  };
  if (draft.kind === "tool") {
    definition.tool_name = draft.tool_name.trim();
    definition.tool_description = draft.tool_description.trim();
    const input = parseSchema(draft.input_schema, "input_schema", issues);
    if (input) definition.input_schema = input;
    const output = parseSchema(draft.output_schema, "output_schema", issues);
    if (output) definition.output_schema = output;
  }
  return issues.length > 0 ? { issues } : { definition: definitionPayload(definition), issues };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function changedSections(base: EditorDraft, draft: EditorDraft): Map<SectionId, string> {
  const out = new Map<SectionId, string>();
  if (base.name !== draft.name || base.description !== draft.description || base.timeout_ms !== draft.timeout_ms || base.id !== draft.id || base.kind !== draft.kind) {
    out.set("details", "details");
  }
  if (base.source !== draft.source) out.set("source", "source");
  if (!same(contractSnapshot(base.source, base.kind, base.capabilities, base.bindings), contractSnapshot(draft.source, draft.kind, draft.capabilities, draft.bindings))) {
    out.set("contract", "capabilities");
  }
  if (
    draft.kind === "tool" &&
    (base.tool_name !== draft.tool_name ||
      base.tool_description !== draft.tool_description ||
      base.input_schema !== draft.input_schema ||
      base.output_schema !== draft.output_schema)
  ) {
    out.set("tool", "tool interface");
  }
  return out;
}

const PATCH_PATHS: Record<keyof EditorDraft, string> = {
  id: "id",
  name: "name",
  description: "description",
  kind: "kind",
  source: "source",
  timeout_ms: "timeout_ms",
  capabilities: "capabilities",
  bindings: "bindings",
  tool_name: "tool_name",
  tool_description: "tool_description",
  input_schema: "input_schema",
  output_schema: "output_schema",
};

const KNOWN_PATHS = Object.values(PATCH_PATHS);

function useSectionSpy(sections: SectionId[]) {
  const [active, setActive] = useState<SectionId>(sections[0]!);
  const scrollRef = useRef<HTMLDivElement>(null);
  const onScroll = useCallback(() => {
    const root = scrollRef.current;
    if (!root) return;
    const top = root.getBoundingClientRect().top;
    let current = sections[0]!;
    for (const id of sections) {
      const node = document.getElementById(domId(id));
      if (node && node.getBoundingClientRect().top - top <= 24) current = id;
    }
    setActive(current);
  }, [sections]);
  const jump = useCallback((id: SectionId) => {
    setActive(id);
    document.getElementById(domId(id))?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);
  return { active, jump, scrollRef, onScroll };
}

function KindPicker({ value, onChange }: { value: FunctionKind; onChange: (kind: FunctionKind) => void }) {
  return (
    <div role="radiogroup" aria-label="Kind" className="grid grid-cols-1 gap-2 md:grid-cols-3">
      {FUNCTION_KINDS.map((kind) => {
        const meta = KIND_META[kind];
        const active = kind === value;
        return (
          <button
            key={kind}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(kind)}
            className={`flex flex-col items-start gap-1.5 rounded-lg border p-3 text-left ${
              active ? "border-[var(--sf-text-3)] bg-[var(--sf-raised)]" : "border-[var(--sf-hairline-strong)] bg-[var(--sf-panel)] hover:border-[var(--sf-text-3)]"
            }`}
          >
            <span className={`flex items-center gap-2 text-[13px] font-medium leading-normal text-[var(--sf-text-1)] [&>span>svg]:size-3.5`}>
              <span className={`flex ${meta.accent}`}>{meta.icon}</span>
              {meta.label}
            </span>
            <span className="text-xs leading-[1.4] text-[var(--sf-text-3)]">{meta.summary}</span>
          </button>
        );
      })}
    </div>
  );
}

export function FunctionEditorPage({
  functionId,
  creating = false,
  loaded,
  initialKind,
}: {
  functionId?: string;
  creating?: boolean;
  loaded?: FunctionDetail;
  initialKind?: FunctionKind;
}) {
  const [detail, setDetail] = useState<FunctionDetail | null>(loaded ?? null);
  const [draft, setDraft] = useState<EditorDraft>(loaded ? draftFromDetail(loaded) : emptyDraft(initialKind));
  const [issues, setIssues] = useState<FunctionIssue[]>(loaded?.issues ?? []);
  const [invocations, setInvocations] = useState<FunctionInvocation[]>([]);
  const [busy, setBusy] = useState(false);
  const [idTouched, setIdTouched] = useState(false);
  const [toolNameTouched, setToolNameTouched] = useState(false);
  const [toolDescriptionTouched, setToolDescriptionTouched] = useState(false);
  const [conflict, setConflict] = useState<FunctionDetail | null>(null);
  const [duplicateId, setDuplicateId] = useState<string | null>(null);
  const [duplicateError, setDuplicateError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [usages, setUsages] = useState<FunctionUsage[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const isNew = creating || !detail;
  const base = useMemo(() => (detail && !creating ? draftFromDetail(detail) : emptyDraft(initialKind)), [detail, creating, initialKind]);

  const refreshInvocations = useCallback(() => {
    if (!functionId) return;
    void functionsApi.invocations(functionId).then(setInvocations, () => undefined);
  }, [functionId]);

  useEffect(() => {
    if (loaded || creating || !functionId) return;
    let live = true;
    void functionsApi.get(functionId).then(
      (next) => {
        if (!live) return;
        setDetail(next);
        setDraft(draftFromDetail(next));
        setIssues(next.issues);
      },
      (err: unknown) => {
        if (live) setLoadError(err instanceof Error ? err.message : String(err));
      },
    );
    refreshInvocations();
    return () => {
      live = false;
    };
  }, [creating, functionId, loaded, refreshInvocations]);

  const localIssues = useMemo(() => toDefinition(draft).issues, [draft]);
  const allIssues = useMemo(() => [...issues, ...localIssues], [issues, localIssues]);
  const unmatched = allIssues.filter((issue) => issuesAt([issue], ...KNOWN_PATHS).length === 0);
  const changed = useMemo(() => changedSections(base, draft), [base, draft]);
  const dirty = changed.size > 0;
  const missingRequired = isNew && (draft.id.trim() === "" || draft.name.trim() === "");
  const blocking = localIssues.length > 0;
  const canSave = dirty && !busy && !blocking && !missingRequired && conflict === null;
  const revision = detail?.revision;

  const sections: SectionId[] = useMemo(
    () => ["details", "source", "contract", ...(draft.kind === "tool" ? (["tool"] as SectionId[]) : []), "test", ...(isNew ? [] : (["history"] as SectionId[]))],
    [draft.kind, isNew],
  );
  const spy = useSectionSpy(sections);

  function patch(partial: Partial<EditorDraft>) {
    setDraft((current) => {
      const next = { ...current, ...partial };
      if (partial.kind && partial.kind !== current.kind && creating) next.source = FUNCTION_TEMPLATES[partial.kind];
      if (partial.name !== undefined && creating && !idTouched) next.id = slugId(partial.name);
      const followed = followToolFields(creating, next.kind, next, {
        toolName: toolNameTouched || partial.tool_name !== undefined,
        toolDescription: toolDescriptionTouched || partial.tool_description !== undefined,
      });
      next.tool_name = followed.tool_name;
      next.tool_description = followed.tool_description;
      return next;
    });
    const keys = Object.keys(partial) as Array<keyof EditorDraft>;
    setIssues((current) => current.filter((issue) => issuesAt([issue], ...keys.map((key) => PATCH_PATHS[key])).length === 0));
  }

  function adopt(next: FunctionDetail) {
    setDetail(next);
    setDraft(draftFromDetail(next));
    setIssues(next.issues);
    setConflict(null);
  }

  async function save() {
    if (!canSave) return;
    const built = toDefinition(draft);
    if (!built.definition) return;
    setBusy(true);
    try {
      if (isNew) {
        const created = await functionsApi.create(built.definition);
        showToast(`Created ${created.name ?? created.id}`);
        navigate(functionPath(created.id));
        return;
      }
      const saved = await saveOrSurfaceConflict(detail!.id, detail!.revision, built.definition);
      if (saved.ok) {
        adopt(saved.detail);
        showToast(`Saved as revision ${saved.detail.revision}`);
      } else if (saved.kind === "conflict") {
        setConflict(saved.detail);
      } else {
        setIssues(saved.issues);
      }
    } catch (err) {
      const issuesFromError = err instanceof FunctionApiError && err.issues.length > 0 ? err.issues : null;
      setIssues(issuesFromError ?? [{ path: "", code: "function.invalid", message: err instanceof Error ? err.message : String(err) }]);
    } finally {
      setBusy(false);
    }
  }

  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void saveRef.current();
      }
    };
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (dirty) event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [dirty]);

  async function duplicate() {
    if (!detail || !duplicateId?.trim()) return;
    setBusy(true);
    setDuplicateError(null);
    try {
      const copy = await functionsApi.duplicate(detail.id, duplicateId.trim());
      showToast(`Duplicated as ${copy.id}`);
      navigate(functionPath(copy.id));
    } catch (err) {
      setDuplicateError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!detail) return;
    try {
      await functionsApi.remove(detail.id);
      showToast(`Deleted ${draft.name || detail.id}`);
      navigate(functionsPath());
    } catch (err) {
      if (err instanceof FunctionApiError && err.code === "function.in_use") setUsages(err.usages ?? []);
      else {
        setConfirmDelete(false);
        showToast(err instanceof Error ? err.message : "Could not delete the function");
      }
    }
  }

  if (!creating && !detail) {
    return (
      <div className={PAGE_BG}>
        <PageHeader crumbs={[{ label: "Functions", onClick: () => navigate(functionsPath()) }]} title={functionId ?? "Function"} />
        <div className="flex flex-1 flex-col items-center justify-center gap-4 p-10 text-center">
          {loadError ? (
            <>
              <p role="alert" className="max-w-md text-[13px] leading-normal text-[var(--sf-text-2)]">
                {loadError}
              </p>
              <Button onClick={() => navigate(functionsPath())}>Back to functions</Button>
            </>
          ) : (
            <p className="text-[13px] text-[var(--sf-text-3)]">Loading function…</p>
          )}
        </div>
      </div>
    );
  }

  const title = isNew ? draft.name || "New function" : draft.name || draft.id;
  const changedLabels = [...changed.values()];
  const kindMeta = KIND_META[draft.kind];
  const capabilitiesChanged = changed.has("contract") && !isNew;
  const accessState = declaredAccessState(draft.source, draft.capabilities);

  return (
    <div className={PAGE_BG}>
      <PageHeader
        crumbs={[{ label: "Functions", onClick: () => navigate(functionsPath()) }]}
        title={title}
        titleAddon={
          <>
            <KindPill kind={draft.kind} />
            {revision !== undefined ? (
              <span className={`${MONO} shrink-0 rounded-md bg-[var(--sf-raised)] px-2 py-0.5 text-xs leading-[1.33333] text-[var(--sf-text-2)] ${NOWRAP}`}>
                Revision {revision}
              </span>
            ) : null}
          </>
        }
        description={
          isNew
            ? "A new function is saved to the project as functions/<id>.function.yaml."
            : "Saving creates a new revision. Runs and sessions already in flight keep the revision they started on."
        }
        actions={
          <>
            {detail && !isNew ? (
              <Button variant="ghost" icon={<LuCopy aria-hidden />} title="Duplicate" onClick={() => setDuplicateId(`${detail.id}_copy`)}>
                <span className="hidden xl:inline">Duplicate</span>
                <span className="sr-only xl:hidden">Duplicate</span>
              </Button>
            ) : null}
            <Button variant="primary" disabled={!canSave} onClick={() => void save()}>
              {busy ? "Saving…" : isNew ? "Create function" : `Save as revision ${(revision ?? 0) + 1}`}
            </Button>
          </>
        }
      />

      <div className="flex min-h-0 flex-1">
        <div className="hidden w-[220px] shrink-0 flex-col justify-between border-r border-r-[var(--sf-hairline)] px-3 py-4 md:flex">
          <nav className="flex flex-col gap-0.5" aria-label="Function sections">
            {sections.map((id) => (
              <button
                key={id}
                type="button"
                onClick={() => spy.jump(id)}
                className={`flex items-center justify-between rounded-md px-2.5 py-1.5 text-left text-[13px] leading-normal ${
                  spy.active === id ? "bg-[var(--sf-raised)] font-medium text-[var(--sf-text-1)]" : "text-[var(--sf-text-2)] hover:text-[var(--sf-text-1)]"
                }`}
              >
                {SECTION_LABEL[id]}
                {changed.has(id) ? <ChangedDot /> : null}
              </button>
            ))}
          </nav>
          {isNew ? null : (
            <div className="flex flex-col gap-1 border-t border-t-[var(--sf-hairline)] pt-3">
              {confirmDelete ? (
                <div className="flex flex-col gap-1.5 rounded-md bg-[var(--sf-fail-bg)] px-2.5 py-2">
                  {usages && usages.length > 0 ? (
                    <>
                      <span className="text-xs leading-[1.33333] text-[var(--sf-text-1)]">Still used by {usages.length === 1 ? "1 place" : `${usages.length} places`}. Detach it first:</span>
                      <ul className="flex flex-col gap-0.5">
                        {usages.slice(0, 4).map((usage) => (
                          <li key={`${usage.kind}:${usage.path}`} className={`${MONO} truncate text-[11px] text-[var(--sf-text-2)]`} title={usage.path}>
                            {usage.path}
                          </li>
                        ))}
                        {usages.length > 4 ? <li className="text-[11px] text-[var(--sf-text-3)]">+{usages.length - 4} more</li> : null}
                      </ul>
                      <button type="button" onClick={() => { setConfirmDelete(false); setUsages(null); }} className="w-fit text-xs text-[var(--sf-text-2)]">
                        Close
                      </button>
                    </>
                  ) : (
                    <>
                      <span className="text-xs leading-[1.33333] text-[var(--sf-text-1)]">Remove functions/{detail?.id}.function.yaml? History stays readable.</span>
                      <div className="flex gap-2">
                        <button type="button" onClick={() => void remove()} className="text-xs font-medium text-[var(--sf-fail)]">
                          Delete
                        </button>
                        <button type="button" onClick={() => setConfirmDelete(false)} className="text-xs text-[var(--sf-text-2)]">
                          Cancel
                        </button>
                      </div>
                    </>
                  )}
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmDelete(true)}
                  className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] leading-normal text-[var(--sf-fail)] hover:bg-[var(--sf-fail-bg)]"
                >
                  <LuTrash2 aria-hidden className="size-3.5" />
                  Delete function
                </button>
              )}
            </div>
          )}
        </div>

        <div className="flex min-w-0 flex-1 flex-col">
          <div
            className={`flex h-11 shrink-0 items-center justify-between gap-4 border-b border-b-[var(--sf-hairline)] px-7 ${
              conflict ? "bg-[var(--sf-fail-bg)]" : dirty ? "bg-[#6ca6ff0a]" : ""
            }`}
          >
            {conflict ? (
              <span className="flex items-center gap-2 text-xs leading-[1.33333] text-[var(--sf-fail)]" role="alert">
                <LuTriangleAlert aria-hidden className="size-3 shrink-0" />
                This function is now at revision {conflict.revision}. Reload to see it; your unsaved edits will be dropped.
                <button type="button" onClick={() => adopt(conflict)} className="font-medium underline">
                  Reload
                </button>
              </span>
            ) : isNew ? (
              <div className="flex items-center gap-3">
                <span className="text-xs leading-[1.33333] text-[var(--sf-text-3)]">Not saved yet</span>
                {dirty ? (
                  <button type="button" onClick={() => setDraft(base)} className={`text-xs leading-[1.33333] text-[var(--sf-running)] ${NOWRAP}`}>
                    Start over
                  </button>
                ) : null}
              </div>
            ) : dirty ? (
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <ChangedDot />
                <span className={`text-xs font-medium leading-[1.33333] text-[var(--sf-text-1)] ${NOWRAP}`}>
                  {changedLabels.length} unsaved change{changedLabels.length === 1 ? "" : "s"}
                </span>
                <span className="truncate text-xs leading-[1.33333] text-[var(--sf-text-2)]">
                  {changedLabels.map((label, index) => (index === 0 ? label[0]!.toUpperCase() + label.slice(1) : label)).join(" · ")}
                </span>
                <button type="button" disabled={busy} onClick={() => setDraft(base)} className={`shrink-0 text-xs leading-[1.33333] text-[var(--sf-running)] disabled:opacity-50 ${NOWRAP}`}>
                  Discard changes
                </button>
              </div>
            ) : (
              <span className="text-xs leading-[1.33333] text-[var(--sf-text-3)]">No unsaved changes</span>
            )}
            {conflict ? null : allIssues.length > 0 ? (
              <span className={`flex shrink-0 items-center gap-1.5 text-xs leading-[1.33333] text-[var(--sf-fail)] ${NOWRAP}`}>
                <LuTriangleAlert aria-hidden className="size-3" />
                {allIssues.length} to fix{blocking ? " before saving" : ""}
              </span>
            ) : (dirty || isNew) && missingRequired ? (
              <span className={`text-xs leading-[1.33333] text-[var(--sf-text-3)] ${NOWRAP}`}>Add a name to save</span>
            ) : dirty ? (
              <span className={`flex shrink-0 items-center gap-1.5 text-xs leading-[1.33333] text-[var(--sf-ok)] ${NOWRAP}`}>
                <LuCheck aria-hidden className="size-3" />
                Ready to save
              </span>
            ) : null}
          </div>

          <div ref={spy.scrollRef} onScroll={spy.onScroll} className="min-h-0 flex-1 overflow-y-auto">
            <div className="flex max-w-[920px] flex-col gap-8 px-7 py-6">
              {loadError ? (
                <Callout tone="fail" role="alert">
                  <span>{loadError}</span>
                </Callout>
              ) : null}
              {unmatched.length > 0 ? (
                <Callout tone="fail" role="alert">
                  <span className="font-medium">{unmatched.length === 1 ? "This function has a problem" : `This function has ${unmatched.length} problems`}</span>
                  {unmatched.map((issue, index) => (
                    <span key={`${issue.path}-${issue.code}-${index}`} className="text-[var(--sf-text-2)]">
                      {issue.message}
                    </span>
                  ))}
                </Callout>
              ) : null}

              <section id={domId("details")} className="flex scroll-mt-4 flex-col gap-4">
                <SectionHeading note={isNew ? "Pick what the function does, then name it." : kindMeta.summary + " " + kindMeta.where}>Details</SectionHeading>
                {isNew ? (
                  <Field label="Kind" hint={`${kindMeta.where} ${kindMeta.returns}`}>
                    <KindPicker value={draft.kind} onChange={(kind) => patch({ kind })} />
                  </Field>
                ) : null}
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <Field label="Name" changed={!isNew && base.name !== draft.name}>
                    <TextBox ariaLabel="Name" value={draft.name} placeholder="Score check" invalid={issuesAt(allIssues, "name").length > 0} changed={!isNew && base.name !== draft.name} onChange={(name) => patch({ name })} />
                    <FieldMessages issues={issuesAt(allIssues, "name")} />
                  </Field>
                  <Field label="Id" hint={isNew ? "Used in YAML and attachments. Fixed once created." : "Fixed once created."}>
                    <TextBox
                      mono
                      ariaLabel="Id"
                      value={draft.id}
                      readOnly={!isNew}
                      placeholder="score_check"
                      invalid={issuesAt(allIssues, "id").length > 0}
                      onChange={
                        isNew
                          ? (id) => {
                              setIdTouched(true);
                              patch({ id });
                            }
                          : undefined
                      }
                    />
                    <FieldMessages issues={issuesAt(allIssues, "id")} />
                  </Field>
                  <div className="md:col-span-2">
                    <Field label="Description" hint="Shown in the directory and when attaching.">
                      <TextBox
                        ariaLabel="Description"
                        value={draft.description}
                        placeholder="What it checks, picks or does"
                        changed={!isNew && base.description !== draft.description}
                        onChange={(description) => patch({ description })}
                      />
                      <FieldMessages issues={issuesAt(allIssues, "description")} />
                    </Field>
                  </div>
                  <Field label="Timeout" hint="Between 1 and 30,000 ms. A run is stopped when it expires.">
                    <NumberField
                      ariaLabel="Timeout"
                      value={draft.timeout_ms}
                      min={1}
                      max={30000}
                      suffix="ms"
                      invalid={issuesAt(allIssues, "timeout_ms").length > 0}
                      changed={!isNew && base.timeout_ms !== draft.timeout_ms}
                      onChange={(value) => patch({ timeout_ms: value ?? 0 })}
                    />
                    <FieldMessages issues={issuesAt(allIssues, "timeout_ms")} />
                  </Field>
                  {isNew ? null : (
                    <Field label="Kind" hint="Fixed once created.">
                      <div className="flex h-9 items-center">
                        <KindPill kind={draft.kind} />
                      </div>
                    </Field>
                  )}
                </div>
              </section>

              <section id={domId("source")} className="flex scroll-mt-4 flex-col gap-3">
                <SectionHeading
                  note={`Export a default function execute(context). ${kindMeta.returns} It runs sealed: it can only use what you grant under Access.`}
                  aside={changed.has("source") ? <ChangedDot /> : undefined}
                >
                  Source
                </SectionHeading>
                <FunctionSourceEditor key={revision ?? "new"} value={draft.source} onChange={(source) => patch({ source })} invalid={issuesAt(allIssues, "source").length > 0} />
                <FieldMessages issues={issuesAt(allIssues, "source")} />
              </section>

              <section id={domId("contract")} className="flex scroll-mt-4 flex-col gap-4">
                <SectionHeading
                  note="What this function may touch. Each stage or agent that uses it has to grant every capability you list."
                  aside={changed.has("contract") ? <ChangedDot /> : undefined}
                >
                  Access
                </SectionHeading>
                {accessState.mode === "legacy" ? (
                  <>
                    <FunctionContractFields
                      kind={draft.kind}
                      capabilities={draft.capabilities}
                      bindings={draft.bindings}
                      onChange={({ capabilities, bindings }) => patch({ capabilities, bindings })}
                    />
                    <div className="flex flex-col items-start gap-2">
                      <Button
                        size="sm"
                        onClick={() => patch({ source: moveLegacyAccessIntoSource(draft.source, draft.capabilities, draft.bindings) })}
                      >
                        Move access into the source
                      </Button>
                      <p className="text-xs leading-[1.4] text-[var(--sf-text-3)]">
                        Attachments will ask you to review access once, because capability ids are now derived from the code.
                      </p>
                    </div>
                  </>
                ) : (
                  <FunctionDeclaredAccess
                    kind={draft.kind}
                    state={accessState}
                    onChange={(access) => patch({ source: applyDeclaredControl(draft.source, access) })}
                  />
                )}
                <FieldMessages issues={issuesAt(allIssues, "capabilities", "bindings")} />
                {capabilitiesChanged ? (
                  <p className="flex items-start gap-2 text-xs leading-normal text-[var(--sf-needs)]">
                    <LuTriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                    Changing a capability makes every attachment that doesn't grant the updated one fail validation until you update its grants.
                  </p>
                ) : null}
              </section>

              {draft.kind === "tool" ? (
                <section id={domId("tool")} className="flex scroll-mt-4 flex-col gap-4">
                  <SectionHeading note="What the model sees when it can call this tool." aside={changed.has("tool") ? <ChangedDot /> : undefined}>
                    Tool interface
                  </SectionHeading>
                  <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                    <Field label="Tool name" hint="Defaults to the id.">
                      <TextBox
                        mono
                        ariaLabel="Tool name"
                        value={draft.tool_name}
                        placeholder="total_counts"
                        invalid={issuesAt(allIssues, "tool_name").length > 0}
                        onChange={(tool_name) => {
                          setToolNameTouched(true);
                          patch({ tool_name });
                        }}
                      />
                      <FieldMessages issues={issuesAt(allIssues, "tool_name")} />
                    </Field>
                    <Field label="Tool description" hint="Defaults to the description.">
                      <TextBox
                        ariaLabel="Tool description"
                        value={draft.tool_description}
                        placeholder="Add up a list of counts"
                        invalid={issuesAt(allIssues, "tool_description").length > 0}
                        onChange={(tool_description) => {
                          setToolDescriptionTouched(true);
                          patch({ tool_description });
                        }}
                      />
                      <FieldMessages issues={issuesAt(allIssues, "tool_description")} />
                    </Field>
                    <div className="md:col-span-2">
                      <Field label="Input schema" hint="A JSON Schema object for the input. Nesting stops at 8 levels, with at most 64 properties per object.">
                        <CodeArea ariaLabel="Input schema" value={draft.input_schema} rows={8} invalid={issuesAt(allIssues, "input_schema").length > 0} onChange={(input_schema) => patch({ input_schema })} />
                        <FieldMessages issues={issuesAt(allIssues, "input_schema")} />
                      </Field>
                    </div>
                    <div className="md:col-span-2">
                      <Field label="Output schema" hint="Optional. When set, the result is checked against it.">
                        <CodeArea ariaLabel="Output schema" value={draft.output_schema} rows={5} placeholder='{ "type": "object" }' invalid={issuesAt(allIssues, "output_schema").length > 0} onChange={(output_schema) => patch({ output_schema })} />
                        <FieldMessages issues={issuesAt(allIssues, "output_schema")} />
                      </Field>
                    </div>
                  </div>
                </section>
              ) : null}

              <section id={domId("test")} className="flex scroll-mt-4 flex-col gap-4">
                <SectionHeading note="Try the function on a sample context before anything depends on it.">Test</SectionHeading>
                <FunctionTestPanel functionId={isNew ? undefined : detail?.id} kind={draft.kind} source={draft.source} savedSource={detail?.definition?.source} onRan={refreshInvocations} />
              </section>

              {isNew ? null : (
                <section id={domId("history")} className="flex scroll-mt-4 flex-col gap-4">
                  <SectionHeading note="Most recent runs of this function.">History</SectionHeading>
                  <FunctionHistory invocations={invocations} />
                </section>
              )}
            </div>
          </div>
        </div>
      </div>

      <PageFooter
        left={isNew ? "functions/<id>.function.yaml · not saved yet" : `functions/${detail?.id}.function.yaml · revision ${revision} saved`}
        right="⌘S to save"
      />

      {duplicateId !== null ? (
        <Dialog
          title="Duplicate function"
          onClose={() => {
            setDuplicateId(null);
            setDuplicateError(null);
          }}
          narrow
          footer={
            <>
              <Button
                onClick={() => {
                  setDuplicateId(null);
                  setDuplicateError(null);
                }}
              >
                Cancel
              </Button>
              <Button variant="primary" disabled={busy || duplicateId.trim() === ""} onClick={() => void duplicate()}>
                {busy ? "Duplicating…" : "Duplicate"}
              </Button>
            </>
          }
        >
          <div
            className="flex flex-col gap-3 px-4 py-4"
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void duplicate();
              }
            }}
          >
            <Field label="New id" hint="The copy starts from this revision's definition and has its own history.">
              <TextBox mono ariaLabel="New id" value={duplicateId} invalid={duplicateError !== null} onChange={setDuplicateId} />
            </Field>
            {duplicateError ? (
              <p role="alert" className="text-xs leading-[1.33333] text-[var(--sf-fail)]">
                {duplicateError}
              </p>
            ) : null}
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}
