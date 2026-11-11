import { useEffect, useState } from "react";
import { functionsApi, FunctionApiError, type FunctionBinding, type FunctionCapability, type FunctionDefinition, type FunctionDetail, type FunctionInvocation, type FunctionIssue, type FunctionKind, type FunctionRunView } from "../../api/functions";
import { functionPath, functionsPath, navigate } from "../../routes";
import { Dialog } from "../agents/editor/Dialogs";
import { MONO, PAGE_BG } from "../agents/agentsTokens";
import { Button, Toggle } from "../agents/ui";
import { PageHeader } from "../shell/PageHeader";
import { FunctionContractFields } from "./FunctionContractFields";
import { FunctionSourceEditor } from "./FunctionSourceEditor";
import { FUNCTION_TEMPLATES, saveOrSurfaceConflict, testRequestBody } from "./functionsPageModel";

const KINDS: FunctionKind[] = ["verification", "routing", "tool"];

const FIELD = "flex h-8 w-full rounded-lg border border-[var(--sf-hairline-strong)] bg-[var(--sf-panel)] px-2.5 text-[13px] text-[var(--sf-text-1)] outline-none";

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
    input_schema: "{\n  \"type\": \"object\",\n  \"properties\": {},\n  \"additionalProperties\": false\n}",
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
      issues.push({ path: field, code: "function.schema", message: `${field} must be a JSON object` });
      return undefined;
    }
    return value as Record<string, unknown>;
  } catch {
    issues.push({ path: field, code: "function.schema", message: `${field} must be JSON` });
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
  return issues.length > 0 ? { issues } : { definition, issues };
}

export function FunctionEditorPage({
  functionId,
  creating = false,
  loaded,
}: {
  functionId?: string;
  creating?: boolean;
  loaded?: FunctionDetail;
}) {
  const [detail, setDetail] = useState<FunctionDetail | null>(loaded ?? null);
  const [draft, setDraft] = useState<EditorDraft>(loaded ? draftFromDetail(loaded) : emptyDraft());
  const [issues, setIssues] = useState<FunctionIssue[]>(loaded?.issues ?? []);
  const [real, setReal] = useState(false);
  const [sampleInput, setSampleInput] = useState("{\n}");
  const [run, setRun] = useState<FunctionRunView | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [invocations, setInvocations] = useState<FunctionInvocation[]>([]);
  const [busy, setBusy] = useState(false);
  const [duplicateId, setDuplicateId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

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
    void functionsApi.invocations(functionId).then(
      (rows) => {
        if (live) setInvocations(rows);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [creating, functionId, loaded]);

  function patch(partial: Partial<EditorDraft>) {
    setDraft((current) => {
      const next = { ...current, ...partial };
      if (partial.kind && partial.kind !== current.kind && creating) next.source = FUNCTION_TEMPLATES[partial.kind];
      return next;
    });
  }

  async function save() {
    const built = toDefinition(draft);
    if (!built.definition) {
      setIssues(built.issues);
      return;
    }
    setBusy(true);
    try {
      if (creating || !detail) {
        const created = await functionsApi.create(built.definition);
        navigate(functionPath(created.id));
        return;
      }
      const saved = await saveOrSurfaceConflict(detail.id, detail.revision, built.definition);
      if (saved.ok) {
        setDetail(saved.detail);
        setDraft(draftFromDetail(saved.detail));
        setIssues(saved.detail.issues);
        return;
      }
      if (saved.kind === "conflict") {
        setDetail(saved.detail);
        setDraft(draftFromDetail(saved.detail));
        setIssues([]);
        return;
      }
      setIssues(saved.issues);
    } catch (err) {
      setIssues([{ path: "", code: "function.invalid", message: err instanceof Error ? err.message : String(err) }]);
    } finally {
      setBusy(false);
    }
  }

  async function runTest() {
    if (!detail) return;
    let input: unknown = {};
    try {
      input = JSON.parse(sampleInput) as unknown;
    } catch {
      setRunError("Sample input must be JSON");
      return;
    }
    setBusy(true);
    setRunError(null);
    try {
      const body = testRequestBody({
        source: draft.source === detail.definition?.source ? undefined : draft.source,
        input,
        real,
      });
      const result = await functionsApi.test(detail.id, body);
      setRun(result);
      const history = await functionsApi.invocations(detail.id);
      setInvocations(history);
    } catch (err) {
      setRun(null);
      setRunError(err instanceof FunctionApiError ? err.message : err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function duplicate() {
    if (!detail || !duplicateId?.trim()) return;
    setBusy(true);
    try {
      const copy = await functionsApi.duplicate(detail.id, duplicateId.trim());
      navigate(functionPath(copy.id));
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
      setDuplicateId(null);
    } finally {
      setBusy(false);
    }
  }

  const revision = detail?.revision;

  return (
    <div className={PAGE_BG}>
      <PageHeader
        crumbs={[{ label: "Functions", onClick: () => navigate(functionsPath()) }]}
        title={creating ? "New function" : draft.name || draft.id || "Function"}
        titleAddon={revision !== undefined ? <span className={`${MONO} text-[13px] text-[var(--sf-text-2)]`}>Revision {revision}</span> : null}
        actions={
          <div className="flex items-center gap-2">
            {detail ? (
              <Button variant="ghost" onClick={() => setDuplicateId(`${detail.id}_copy`)}>
                Duplicate
              </Button>
            ) : null}
            <Button variant="primary" disabled={busy} onClick={() => void save()}>
              Save
            </Button>
          </div>
        }
      />
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 py-5">
        {loadError ? (
          <p role="alert" className="text-[13px] text-[var(--sf-fail)]">
            {loadError}
          </p>
        ) : null}
        {issues.map((issue, index) => (
          <p key={`${issue.path}-${issue.code}-${index}`} role="alert" className="text-[13px] text-[var(--sf-fail)]">
            {issue.message}
          </p>
        ))}
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <label className="flex flex-col gap-1 text-xs text-[var(--sf-text-3)]">
            Id
            <input aria-label="Id" className={FIELD} value={draft.id} disabled={!creating} onChange={(event) => patch({ id: event.target.value })} />
          </label>
          <label className="flex flex-col gap-1 text-xs text-[var(--sf-text-3)]">
            Name
            <input aria-label="Name" className={FIELD} value={draft.name} onChange={(event) => patch({ name: event.target.value })} />
          </label>
          <label className="flex flex-col gap-1 text-xs text-[var(--sf-text-3)] md:col-span-2">
            Description
            <input aria-label="Description" className={FIELD} value={draft.description} onChange={(event) => patch({ description: event.target.value })} />
          </label>
          <label className="flex flex-col gap-1 text-xs text-[var(--sf-text-3)]">
            Kind
            <select
              aria-label="Kind"
              className={FIELD}
              value={draft.kind}
              disabled={!creating}
              onChange={(event) => patch({ kind: event.target.value as FunctionKind })}
            >
              {KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {kind}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-[var(--sf-text-3)]">
            Timeout (ms)
            <input
              aria-label="Timeout"
              className={FIELD}
              type="number"
              min={1}
              max={30000}
              value={draft.timeout_ms}
              onChange={(event) => patch({ timeout_ms: Number(event.target.value) })}
            />
          </label>
        </div>
        <FunctionContractFields
          kind={draft.kind}
          capabilities={draft.capabilities}
          bindings={draft.bindings}
          onCapabilities={(capabilities) => patch({ capabilities })}
          onBindings={(bindings) => patch({ bindings })}
        />
        {draft.kind === "tool" ? (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <label className="flex flex-col gap-1 text-xs text-[var(--sf-text-3)]">
              Tool name
              <input aria-label="Tool name" className={FIELD} value={draft.tool_name} onChange={(event) => patch({ tool_name: event.target.value })} />
            </label>
            <label className="flex flex-col gap-1 text-xs text-[var(--sf-text-3)]">
              Tool description
              <input
                aria-label="Tool description"
                className={FIELD}
                value={draft.tool_description}
                onChange={(event) => patch({ tool_description: event.target.value })}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-[var(--sf-text-3)] md:col-span-2">
              Input schema
              <textarea aria-label="Input schema" className={`${FIELD} h-28 py-2 ${MONO}`} value={draft.input_schema} onChange={(event) => patch({ input_schema: event.target.value })} />
              <span>The schema root is an object. Nesting stops at 8 levels, and one schema object has at most 64 properties.</span>
            </label>
          </div>
        ) : null}
        <div className="flex flex-col gap-1.5">
          <span className="text-xs text-[var(--sf-text-3)]">Source</span>
          <FunctionSourceEditor key={revision ?? "new"} value={draft.source} onChange={(source) => patch({ source })} />
        </div>
        <section className="flex flex-col gap-3 rounded-lg border border-[var(--sf-hairline)] p-4" data-testid="function-test-panel">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-[13px] font-medium text-[var(--sf-text-1)]">Test</h2>
            <div className="flex items-center gap-2 text-xs text-[var(--sf-text-2)]">
              <Toggle on={real} onChange={setReal} label="Use real files, environment, and APIs" />
              Use real files, environment, and APIs
            </div>
          </div>
          <p className="text-xs leading-normal text-[var(--sf-text-3)]">
            A test uses mock files, environment, and API responses until you turn on real resources for this run. That choice is not remembered.
          </p>
          <textarea
            aria-label="Sample input"
            className={`${FIELD} h-24 py-2 ${MONO}`}
            value={sampleInput}
            onChange={(event) => setSampleInput(event.target.value)}
          />
          <div>
            <Button variant="secondary" disabled={busy || !detail} onClick={() => void runTest()}>
              Run test
            </Button>
          </div>
          {runError ? (
            <p role="alert" className="text-[13px] text-[var(--sf-fail)]">
              {runError}
            </p>
          ) : null}
          {run ? (
            <div className="flex flex-col gap-1 text-xs text-[var(--sf-text-2)]">
              <span>
                {run.status} · {run.durationMs} ms · revision {run.revision ?? "unsaved"}
              </span>
              {run.message ? <span>{run.message}</span> : null}
              {run.logs ? <pre className={`${MONO} whitespace-pre-wrap text-[var(--sf-text-3)]`}>{run.logs}</pre> : null}
              {run.value !== undefined ? <pre className={`${MONO} whitespace-pre-wrap`}>{JSON.stringify(run.value, null, 2)}</pre> : null}
            </div>
          ) : null}
        </section>
        {invocations.length > 0 ? (
          <section className="flex flex-col gap-2">
            <h2 className="text-[13px] font-medium text-[var(--sf-text-1)]">Invocations</h2>
            {invocations.map((row) => (
              <p key={row.id} className="text-xs text-[var(--sf-text-2)]">
                {row.kind} · {row.status}
                {row.code ? ` · ${row.code}` : ""} · {row.durationMs} ms · revision {row.revision ?? "unsaved"}
              </p>
            ))}
          </section>
        ) : null}
      </div>
      {duplicateId !== null ? (
        <Dialog
          title="Duplicate function"
          onClose={() => setDuplicateId(null)}
          narrow
          footer={
            <Button variant="primary" disabled={busy} onClick={() => void duplicate()}>
              Duplicate
            </Button>
          }
        >
          <label className="flex flex-col gap-1 px-4 py-4 text-xs text-[var(--sf-text-3)]">
            New id
            <input aria-label="New id" className={FIELD} value={duplicateId} onChange={(event) => setDuplicateId(event.target.value)} />
          </label>
        </Dialog>
      ) : null}
    </div>
  );
}
