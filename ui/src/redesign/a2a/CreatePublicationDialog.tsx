import { useEffect, useRef, useState } from "react";
import { A2aApiError, a2aApi, type A2aCaller, type A2aContract, type A2aStageOption } from "../../api/a2a";
import { fetchPipelines } from "../../api/client";
import type { PipelineListing } from "../../api/types";
import { IdentityDialog } from "../identity/identityOverlay";
import { Field, GHOST, INPUT, MONO, PRIMARY, SECONDARY } from "../identity/identityParts";
import { A2aError } from "./A2aParts";
import { ContractPreview } from "./PublicationDialog";
import {
  answerableStages,
  artifactsOf,
  defaultResultStage,
  entryStageCount,
  INPUT_FROM_ENTRY_STAGE,
  newPublication,
  newPublicationReady,
  publicationIdProblem,
  schemaFilesOrNone,
  slugifyId,
  terminalStages,
  toggleCaller,
  type NewPublicationForm,
} from "./a2aView";

const pipelineKey = (row: PipelineListing) => `${row.project_root ?? ""}\n${row.path}`;

function Checks({ options, selected, onChange }: { options: readonly string[]; selected: readonly string[]; onChange: (next: string[]) => void }) {
  return (
    <>
      {options.map((id) => (
        <label key={id} className="flex items-center gap-2 text-[13px] text-[#ecedee]">
          <input type="checkbox" checked={selected.includes(id)} onChange={(event) => onChange(toggleCaller(selected, id, event.target.checked))} />
          <span className={MONO}>{id}</span>
        </label>
      ))}
    </>
  );
}

export function CreatePublicationDialog({
  callers,
  existingIds,
  onClose,
  onSaved,
}: {
  callers: readonly A2aCaller[];
  existingIds: readonly string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const mounted = useRef(true);
  const picked = useRef("");
  const [pipelines, setPipelines] = useState<PipelineListing[] | null>(null);
  const [pipelinesFailed, setPipelinesFailed] = useState(false);
  const [selected, setSelected] = useState("");
  const [schemas, setSchemas] = useState<{ files: string[]; truncated: boolean; failed: boolean } | null>(null);
  const [stages, setStages] = useState<A2aStageOption[] | null>(null);
  const [form, setForm] = useState<NewPublicationForm>({
    projectRoot: "", pipeline: "", name: "", goal: "", description: "", inputSchema: "",
    resultStage: "", includePayload: true, artifacts: [], answerable: [], allowedCallers: [],
  });
  const [contract, setContract] = useState<A2aContract | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code: string; detail: string } | null>(null);

  useEffect(() => {
    mounted.current = true;
    fetchPipelines().then(
      (result) => { if (mounted.current) setPipelines(result.pipelines); },
      () => { if (mounted.current) setPipelinesFailed(true); },
    );
    return () => { mounted.current = false; };
  }, []);

  const patch = (next: Partial<NewPublicationForm>) => { setContract(null); setForm((current) => ({ ...current, ...next })); };

  function choosePipeline(key: string) {
    setSelected(key);
    picked.current = key;
    setSchemas(null);
    setStages(null);
    setError(null);
    const row = pipelines?.find((entry) => pipelineKey(entry) === key);
    if (!row) {
      patch({ projectRoot: "", pipeline: "", inputSchema: "", resultStage: "", artifacts: [], answerable: [] });
      return;
    }
    const projectRoot = row.project_root ?? "";
    patch({ projectRoot, pipeline: row.path, inputSchema: "", resultStage: "", artifacts: [], answerable: [] });
    Promise.all([schemaFilesOrNone(() => a2aApi.schemaFiles(projectRoot)), a2aApi.pipelineStages(projectRoot, row.path)]).then(
      ([files, found]) => {
        if (!mounted.current || picked.current !== key) return;
        setSchemas(files);
        setStages(found);
        const only = defaultResultStage(found);
        patch({ resultStage: only, artifacts: [] });
      },
      (err) => {
        if (!mounted.current || picked.current !== key) return;
        setError(err instanceof A2aApiError ? { code: err.code, detail: err.detail } : { code: "request_failed", detail: "" });
      },
    );
  }

  async function run(work: () => Promise<void>) {
    setError(null);
    setBusy(true);
    try {
      await work();
    } catch (err) {
      if (mounted.current) setError(err instanceof A2aApiError ? { code: err.code, detail: err.detail } : { code: "request_failed", detail: "" });
    }
    if (mounted.current) setBusy(false);
  }

  const idProblem = publicationIdProblem(form.name, existingIds);
  const entries = stages ? entryStageCount(stages) : 1;
  const ready = newPublicationReady(form, existingIds, entries);
  const terminal = stages ? terminalStages(stages) : [];
  const artifactChoices = stages ? artifactsOf(stages, form.resultStage) : [];
  const answerChoices = stages ? answerableStages(stages) : [];

  return (
    <IdentityDialog
      title="Publish a pipeline"
      subtitle="Choose a pipeline from the catalog and what other agents may call it with."
      titleId="a2a-create-publication-title"
      busy={busy}
      width={720}
      onClose={onClose}
      onSubmit={() => void run(async () => {
        await a2aApi.createPublication(newPublication(form));
        onSaved();
      })}
      footer={
        <>
          <span className="text-xs text-[#8b8f98]">Nothing is exposed until you tick a caller. run_stage stays off until allow_run_stage is set on that caller.</span>
          <div className="flex items-center gap-2">
            <button type="button" className={GHOST} onClick={onClose} disabled={busy}>Cancel</button>
            <button type="submit" className={PRIMARY} disabled={busy || !ready}>{busy ? "Publishing…" : "Publish"}</button>
          </div>
        </>
      }
    >
      <Field label="Pipeline" hint={pipelinesFailed ? undefined : "Pipelines from your catalog."} error={pipelinesFailed ? "Could not load the catalog." : undefined}>
        <select className={INPUT} value={selected} disabled={pipelines === null} onChange={(event) => choosePipeline(event.target.value)}>
          <option value="">{pipelines === null && !pipelinesFailed ? "Loading…" : pipelines?.length === 0 ? "No pipelines in the catalog" : "Choose a pipeline"}</option>
          {(pipelines ?? []).map((row) => (
            <option key={pipelineKey(row)} value={pipelineKey(row)}>{row.id} ({row.path})</option>
          ))}
        </select>
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Name"
          hint={form.name.trim() && !idProblem ? <>Published as <span className={MONO}>{slugifyId(form.name)}</span>. The id cannot be changed later.</> : "Shown to the other agent."}
          error={idProblem}
        >
          <input className={INPUT} value={form.name} placeholder="Assess a supplier" autoComplete="off" onChange={(event) => patch({ name: event.target.value })} />
        </Field>
        <Field label="Goal" hint="What a run of this pipeline should achieve.">
          <input className={INPUT} value={form.goal} placeholder="Produce an evidence-backed supplier assessment." autoComplete="off" onChange={(event) => patch({ goal: event.target.value })} />
        </Field>
      </div>
      <Field label="Description" hint="What other agents read to decide whether to call this pipeline.">
        <textarea className={`${INPUT} h-20 resize-y py-2`} value={form.description} onChange={(event) => patch({ description: event.target.value })} />
      </Field>

      {selected && (schemas === null || stages === null) && !error ? <p className="text-xs text-[#8b8f98]" role="status">Reading the pipeline…</p> : null}

      {schemas && stages ? (
        <>
          <Field
            label="Input schema"
            hint={entries !== 1
              ? `This pipeline has ${entries} entry stages, so pick a JSON schema file in the project.`
              : schemas.failed
                ? "Could not list the project's schema files. The entry stage's schema is used."
                : schemas.truncated
                  ? "Only the first files are listed."
                  : "What the other agent sends. By default, what the pipeline's entry stage declares; or a JSON schema file in the project."}
          >
            <select className={`${INPUT} ${MONO}`} value={form.inputSchema} onChange={(event) => patch({ inputSchema: event.target.value })}>
              <option value="">{entries === 1 ? INPUT_FROM_ENTRY_STAGE : "Choose a file"}</option>
              {schemas.files.map((file) => <option key={file} value={file}>{file}</option>)}
            </select>
          </Field>

          <Field
            label="Result stage"
            hint={terminal.length === 0 ? "This pipeline has no stage that can be the result. It needs one final stage and no cloning." : "The final stage whose output the other agent gets back."}
          >
            <select
              className={`${INPUT} ${MONO}`}
              value={form.resultStage}
              disabled={terminal.length === 0}
              onChange={(event) => patch({ resultStage: event.target.value, artifacts: [] })}
            >
              {terminal.length === 1 ? null : <option value="">Choose a stage</option>}
              {terminal.map((stage) => <option key={stage.id} value={stage.id}>{stage.id}</option>)}
            </select>
          </Field>

          {form.resultStage ? (
            <div className="flex flex-col gap-1.5">
              <span className="text-[13px] font-medium text-[#ecedee]">Files the other agent can download</span>
              {artifactChoices.length === 0 ? (
                <span className="text-xs text-[#8b8f98]">This stage declares no files.</span>
              ) : (
                <Checks options={artifactChoices} selected={form.artifacts} onChange={(artifacts) => patch({ artifacts })} />
              )}
            </div>
          ) : null}

          <div className="flex flex-col gap-1.5">
            <span className="text-[13px] font-medium text-[#ecedee]">Stages the caller may answer</span>
            {answerChoices.length === 0 ? (
              <span className="text-xs text-[#8b8f98]">No stage asks only for free text.</span>
            ) : (
              <>
                <span className="text-xs text-[#8b8f98]">Stages whose only question is free text. None are selected unless you tick them.</span>
                <Checks options={answerChoices.map((stage) => stage.id)} selected={form.answerable} onChange={(answerable) => patch({ answerable })} />
              </>
            )}
          </div>

          <label className="flex items-center gap-2 text-[13px] text-[#ecedee]">
            <input type="checkbox" checked={form.includePayload} onChange={(event) => patch({ includePayload: event.target.checked })} />
            Include the result stage&apos;s output in the reply
          </label>
        </>
      ) : null}

      <div className="flex flex-col gap-1.5">
        <span className="text-[13px] font-medium text-[#ecedee]">Callers that may use it</span>
        {callers.length === 0 ? (
          <span className="text-xs text-[#8b8f98]">Add a caller first.</span>
        ) : (
          <Checks options={callers.map((caller) => caller.id)} selected={form.allowedCallers} onChange={(allowedCallers) => patch({ allowedCallers })} />
        )}
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <span className="text-[13px] font-medium text-[#ecedee]">What the other agent will see</span>
          <button
            type="button"
            className={SECONDARY}
            disabled={busy || !ready}
            onClick={() => void run(async () => setContract(await a2aApi.previewPublication(newPublication(form))))}
          >
            {contract ? "Refresh preview" : "Preview contract"}
          </button>
        </div>
        {contract ? <ContractPreview contract={contract} /> : null}
      </div>
      {error ? <A2aError code={error.code} detail={error.detail} /> : null}
    </IdentityDialog>
  );
}
