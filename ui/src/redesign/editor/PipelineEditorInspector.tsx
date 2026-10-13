import { useLayoutEffect, useRef, useState } from "react";
import {
  LuArrowUpRight,
  LuBraces,
  LuCheck,
  LuChevronDown,
  LuExternalLink,
  LuInfo,
  LuLayers,
  LuTriangleAlert,
} from "react-icons/lu";
import type {
  DraftPackagePayload,
  PipelineListing,
  ValidationFinding,
} from "../../api";
import { PromptExpandDialog } from "../workshop/inspector/PromptExpandDialog";
import {
  resolvedStageModel,
  setStageModel,
  setStageSystemPrompt,
  getStageForm,
} from "../workshop/inspector/stageFields";
import {
  INSPECTOR_GATE_ORDER,
  applyGateKindToggle,
  formatPromptTokens,
  inspectorFocusTarget,
  isStageIdValid,
  otherPipelinesUsingStage,
  payloadSchemaLabel,
  readStageSkill,
  sharedStageNotice,
  usedByPipelinesLabel,
  warnedGateKinds,
  writeStageSkill,
  type InspectorFocusTarget,
} from "./editorInspectorModel";
import { stageUsedByCount } from "./pipelineEditorModel";

const LABEL =
  "w-fit text-[11px] font-medium uppercase leading-normal tracking-[0.88px] text-[#8b8f98]";

const MONO = "font-['Geist_Mono',monospace]";

const SELECT_CLASS =
  "h-full w-full min-w-0 appearance-none rounded-lg border border-[#ffffff1a] bg-[#1a1c21] py-0 pl-2.5 pr-7 text-xs text-[#ecedee] outline-none hover:bg-[#ffffff08]";

export type PipelineEditorInspectorProps = {
  draft: DraftPackagePayload;
  baseline?: DraftPackagePayload | null;
  selectedStageId: string | null;
  findings: ValidationFinding[];
  models: string[];
  defaultModel: string | null;
  skills?: readonly string[];
  pipelines: readonly PipelineListing[] | null;
  currentPipelineId?: string;
  projectRoot?: string;
  workshopHref?: string;
  onDraftChange: (draft: DraftPackagePayload) => void;
  onRenameStage: (fromId: string, toId: string) => void;
  onOpenYaml?: (path: string) => void;
  focusRequest?: { field: string; nonce: number } | null;
  width?: number;
};

export function PipelineEditorInspector({
  draft,
  selectedStageId,
  findings,
  models,
  defaultModel,
  skills = [],
  pipelines,
  currentPipelineId,
  projectRoot,
  workshopHref,
  onDraftChange,
  onRenameStage,
  onOpenYaml = () => {},
  focusRequest = null,
  width = 300,
}: PipelineEditorInspectorProps) {
  const form = selectedStageId ? getStageForm(draft, selectedStageId) : null;
  const idKey = `${selectedStageId ?? ""}\0${form?.id ?? ""}`;
  const [idEdit, setIdEdit] = useState<{ key: string; text: string } | null>(null);
  const [promptState, setPromptState] = useState<{ stageId: string; open: boolean } | null>(
    null,
  );
  const idText = idEdit && idEdit.key === idKey ? idEdit.text : (form?.id ?? "");
  const promptOpen = promptState?.stageId === selectedStageId && promptState.open;
  const focusRefs = useRef<Partial<Record<InspectorFocusTarget, HTMLElement>>>({});
  const lastNonce = useRef<number | null>(null);

  function bindFocus(target: InspectorFocusTarget) {
    return (el: HTMLElement | null) => {
      if (el) focusRefs.current[target] = el;
      else delete focusRefs.current[target];
    };
  }

  useLayoutEffect(() => {
    if (!focusRequest || !form) return;
    if (lastNonce.current === focusRequest.nonce) return;
    const el = focusRefs.current[inspectorFocusTarget(focusRequest.field)];
    if (!el) return;
    lastNonce.current = focusRequest.nonce;
    el.scrollIntoView({ block: "nearest" });
    el.focus({ preventScroll: true });
  }, [focusRequest?.field, focusRequest?.nonce, form?.id, selectedStageId]);

  if (!selectedStageId || !form) {
    return (
      <aside
        aria-label="Stage inspector"
        className="flex min-h-0 shrink-0 flex-col bg-[#131418] [font-family:Geist,_sans-serif]"
        style={{ width }}
      >
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
          <p className="text-[13px] font-medium text-[#ecedee]">Click a stage on the graph</p>
          <p className="text-xs leading-[1.45] text-[#8b8f98]">
            Prompt, io, verify, on_verify_fail, and HITL settings show here.
          </p>
        </div>
      </aside>
    );
  }

  const stageRef = { id: form.id, path: form.path, projectRoot };
  const usedBy = stageUsedByCount(pipelines, stageRef);
  const others = otherPipelinesUsingStage(
    pipelines,
    stageRef,
    currentPipelineId ?? draft.pipeline.id,
  );
  const notice = usedBy != null && usedBy >= 2 ? sharedStageNotice(others) : null;
  const skill = readStageSkill(draft, form.id);
  const skillNames = skillSelectOptions(skills, skill);
  const resolved = resolvedStageModel(draft, form, defaultModel);
  const modelValue = form.model ?? resolved ?? "";
  const modelNames = modelSelectOptions(models, modelValue);
  const warned = new Set(warnedGateKinds(findings, form.id));
  const payloadLabel = payloadSchemaLabel({
    outputsRef: form.outputsRef,
    outputFields: form.outputFields,
  });
  const prompt = form.systemPrompt;

  function commitId() {
    const next = idText.trim();
    if (next === form!.id) {
      setIdEdit({ key: idKey, text: form!.id });
      return;
    }
    if (!isStageIdValid(next)) {
      setIdEdit({ key: idKey, text: form!.id });
      return;
    }
    onRenameStage(form!.id, next);
  }

  return (
    <aside
      aria-label="Stage inspector"
      className="flex min-h-0 shrink-0 flex-col overflow-hidden bg-[#131418] [font-family:Geist,_sans-serif]"
      style={{ width }}
    >
      <div
        ref={bindFocus("header")}
        tabIndex={-1}
        className="flex w-full shrink-0 flex-col gap-2 border-b border-b-[#ffffff12] px-3.5 py-3 outline-none"
      >
        <div className="flex items-center gap-1.5">
          <div className={`${LABEL} flex-1`}>Stage</div>
          {workshopHref ? (
            <a
              href={workshopHref}
              aria-label="Open stage in Workshop"
              className="text-[#8b8f98] hover:text-[#ecedee]"
            >
              <LuExternalLink className="size-[13px]" aria-hidden />
            </a>
          ) : null}
        </div>
        <div className="flex min-w-0 items-baseline gap-2">
          <div className={`shrink-0 text-[15px] font-semibold text-[#ecedee] ${MONO}`}>
            {form.id}
          </div>
          <div className={`min-w-0 truncate text-[11px] text-[#8b8f98] ${MONO}`} title={form.inline ? "inline" : (form.path ?? "inline")}>
            {form.inline ? "inline" : form.path}
          </div>
        </div>
        {usedBy != null && usedBy >= 1 ? (
          <div className="flex h-[22px] w-fit items-center gap-[5px] rounded-md border border-[#ffffff1a] bg-[#1a1c21] px-[7px]">
            <LuLayers className="size-3 text-[#a7aab2]" aria-hidden />
            <div className="text-xs text-[#ecedee]">{usedByPipelinesLabel(usedBy)}</div>
          </div>
        ) : null}
      </div>
      <div className="flex min-h-0 w-full flex-1 flex-col gap-3.5 overflow-y-auto p-3.5">
        <div className="flex gap-2.5">
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <div className={LABEL}>id</div>
            <input
              ref={bindFocus("id")}
              aria-label="id"
              value={idText}
              spellCheck={false}
              onChange={(event) => setIdEdit({ key: idKey, text: event.target.value })}
              onBlur={commitId}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  commitId();
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  setIdEdit({ key: idKey, text: form.id });
                }
              }}
              className={`h-[30px] w-full min-w-0 rounded-lg border border-[#ffffff1a] bg-[#1a1c21] px-2.5 text-xs text-[#ecedee] outline-none hover:bg-[#ffffff08] ${MONO}`}
            />
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <div className={LABEL}>skill</div>
            <div className="relative flex h-[30px] items-center">
              <select
                aria-label="skill"
                value={skill}
                onChange={(event) =>
                  onDraftChange(writeStageSkill(draft, form.id, event.target.value))
                }
                className={`${SELECT_CLASS} ${MONO}`}
              >
                <option value="">— none —</option>
                {skillNames.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
              <LuChevronDown
                className="pointer-events-none absolute right-2.5 size-[13px] text-[#8b8f98]"
                aria-hidden
              />
            </div>
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center">
            <div className={`${LABEL} flex-1`}>model</div>
            {form.model ? null : (
              <div className="text-[11px] leading-normal text-[#8b8f98]">from defaults</div>
            )}
          </div>
          <div className="relative flex h-[30px] items-center">
            <select
              ref={bindFocus("model")}
              aria-label="model"
              value={modelValue}
              onChange={(event) =>
                onDraftChange(
                  setStageModel(draft, form.id, event.target.value ? event.target.value : null),
                )
              }
              className={`${SELECT_CLASS} ${MONO}`}
            >
              <option value="">{resolved ? `Inherit (${resolved})` : "Inherit"}</option>
              {modelNames.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
            <LuChevronDown
              className="pointer-events-none absolute right-2.5 size-[13px] text-[#8b8f98]"
              aria-hidden
            />
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center">
            <div className={`${LABEL} flex-1`}>system_prompt</div>
            <div className={`text-[11px] leading-normal text-[#8b8f98] ${MONO}`}>
              {formatPromptTokens(prompt)}
            </div>
          </div>
          <div className="flex flex-col gap-0.5 rounded-lg border border-[#ffffff1a] bg-[#1a1c21] px-2.5 py-2">
            {prompt ? (
              <div
                className={`line-clamp-4 text-[11px] leading-[1.54545] text-[#a7aab2] ${MONO}`}
              >
                {prompt}
              </div>
            ) : (
              <div className={`text-[11px] leading-[1.54545] text-[#8b8f98] ${MONO}`}>
                No system prompt
              </div>
            )}
            <button
              ref={bindFocus("system_prompt")}
              type="button"
              onClick={() => setPromptState({ stageId: form.id, open: true })}
              className="flex items-center gap-1 pt-1 text-left text-xs text-[#ecedee] hover:text-[#ecedee]"
            >
              {prompt ? "Open full prompt" : "Write prompt"}
              <LuArrowUpRight className="size-3" aria-hidden />
            </button>
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <div className={LABEL}>gate_kinds</div>
          <div
            ref={bindFocus("gate_kinds")}
            tabIndex={-1}
            className="grid grid-cols-2 gap-1.5 outline-none"
          >
            {INSPECTOR_GATE_ORDER.map((kind) => {
              const on = form.gateKinds.includes(kind);
              const showWarning = warned.has(kind);
              return (
                <button
                  key={kind}
                  type="button"
                  aria-pressed={on}
                  onClick={() => onDraftChange(applyGateKindToggle(draft, form.id, kind))}
                  className={`flex h-7 min-w-0 items-center gap-[7px] rounded-[7px] border px-2 hover:bg-[#ffffff08] ${
                    on ? "border-[#ffffff29] bg-[#1a1c21]" : "border-[#ffffff12]"
                  }`}
                >
                  {on ? (
                    <span className="flex size-3.5 shrink-0 items-center justify-center rounded-sm bg-[#ecedee]">
                      <LuCheck className="size-2.5 text-[#0c0d0f]" aria-hidden />
                    </span>
                  ) : (
                    <span className="size-3.5 shrink-0 rounded-sm border border-[#ffffff33]" />
                  )}
                  <span
                    className={`text-[11px] ${MONO} ${on ? "text-[#ecedee]" : "text-[#a7aab2]"} ${
                      showWarning ? "min-w-0 flex-1 truncate" : ""
                    }`}
                  >
                    {kind}
                  </span>
                  {showWarning ? (
                    <LuTriangleAlert className="size-[11px] shrink-0 text-[#a7aab2]" aria-hidden />
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <div className={LABEL}>payload_schema</div>
          <button
            ref={bindFocus("payload")}
            type="button"
            onClick={() => onOpenYaml(form.path ?? "")}
            className="flex min-w-0 items-center gap-1.5 text-left hover:text-[#ecedee]"
          >
            <LuBraces className="size-[13px] shrink-0 text-[#a7aab2]" aria-hidden />
            <span
              className={`min-w-0 flex-1 truncate text-xs text-[#ecedee] underline decoration-[#ecedee59] underline-offset-[3px] ${MONO}`}
            >
              {payloadLabel}
            </span>
            <LuArrowUpRight className="size-3 shrink-0 text-[#8b8f98]" aria-hidden />
          </button>
        </div>
      </div>
      {notice ? (
        <div className="flex w-full shrink-0 items-start gap-2 border-t border-t-[#ffffff12] px-3.5 py-2.5">
          <LuInfo className="mx-0 mt-0.5 mb-0 size-[13px] shrink-0 text-[#8b8f98]" aria-hidden />
          <div className="text-xs leading-[1.41667] text-[#a7aab2]">{notice}</div>
        </div>
      ) : null}
      {promptOpen ? (
        <PromptExpandDialog
          stageId={form.id}
          value={prompt}
          onChange={(value) => onDraftChange(setStageSystemPrompt(draft, form.id, value))}
          onClose={() => setPromptState({ stageId: form.id, open: false })}
        />
      ) : null}
    </aside>
  );
}

function skillSelectOptions(skills: readonly string[], current: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const skill of skills) {
    const name = skill.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  const selected = current.trim();
  if (selected && !seen.has(selected)) out.unshift(selected);
  return out;
}

function modelSelectOptions(models: readonly string[], selected: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const model of models) {
    const name = model.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  if (selected && !seen.has(selected)) out.unshift(selected);
  return out;
}
