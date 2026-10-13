import { useMemo } from "react";
import { LuChevronDown, LuChevronUp } from "react-icons/lu";
import type { DraftPackagePayload, ValidationFinding } from "../../../api";
import {
  ChangeTag,
  ChipEditor,
  FieldErrors,
  FieldLabel,
  MONO,
  SelectControl,
  controlClass,
  hasError,
  useLocalText,
} from "./inspectorFields";
import {
  findingsForPipelineField,
  getPipelineForm,
  isUntitledPipelineId,
  movePipelineStage,
  pipelineChanged,
  pipelineFileLabel,
  setPipelineId,
  setPipelineModel,
  setPipelineStageNeeds,
  stageChangeKind,
} from "./stageFields";

export type WorkshopPipelineInspectorProps = {
  draft: DraftPackagePayload;
  baseline: DraftPackagePayload | null;
  findings: ValidationFinding[];
  models: string[];
  defaultModel: string | null;
  onDraftChange: (draft: DraftPackagePayload) => void;
  pipelinePath?: string | null;
};

function PipelineIdField({
  value,
  findings,
  onCommit,
}: {
  value: string;
  findings: ValidationFinding[];
  onCommit: (value: string) => void;
}) {
  const { text, setText, setEditing } = useLocalText(value);

  function commit() {
    setEditing(false);
    const trimmed = text.trim();
    if (!trimmed) {
      setText(value);
      return;
    }
    if (trimmed !== value) onCommit(trimmed);
  }

  return (
    <>
      <div className={controlClass({ error: hasError(findings), className: "h-[30px] px-2.5" })}>
        <input
          aria-label="Pipeline id"
          value={text}
          spellCheck={false}
          placeholder="untitled"
          onFocus={() => setEditing(true)}
          onChange={(event) => setText(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              event.currentTarget.blur();
            } else if (event.key === "Escape") {
              event.preventDefault();
              setText(value);
              setEditing(false);
              event.currentTarget.blur();
            }
          }}
          className={`h-full min-w-0 flex-1 bg-transparent text-xs leading-normal text-[#ecedee] outline-none placeholder:text-[#8b8f98] ${MONO}`}
        />
      </div>
      {isUntitledPipelineId(value) ? (
        <div className="text-[11px] leading-[1.45] text-[#8b8f98]">
          Name the pipeline before saving. The id becomes the pipeline file name.
        </div>
      ) : null}
      <FieldErrors findings={findings} />
    </>
  );
}

export function WorkshopPipelineInspector({
  draft,
  baseline,
  findings,
  models,
  defaultModel,
  onDraftChange,
  pipelinePath,
}: WorkshopPipelineInspectorProps) {
  const form = getPipelineForm(draft);
  const byField = useMemo(() => findingsForPipelineField(findings, draft), [findings, draft]);
  const changed = pipelineChanged(draft, baseline);
  const fileLabel = pipelinePath ?? pipelineFileLabel(form.id);
  const ids = form.stages.map((s) => s.id);
  const modelOptions = [
    { value: "", label: defaultModel ? `Inherits default (${defaultModel})` : "Inherits default" },
    ...Array.from(new Set([...(form.model ? [form.model] : []), ...models])).map((m) => ({ value: m, label: m })),
  ];

  return (
    <div className="flex w-full flex-col">
      <div className="flex w-full shrink-0 flex-col gap-[3px] border-b border-b-[#ffffff12] px-3.5 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <div className={`min-w-0 truncate text-sm font-medium leading-normal text-[#ecedee] ${MONO}`}>
            {form.id.trim() || "untitled"}
          </div>
          <ChangeTag kind={baseline ? (changed ? "edited" : "unchanged") : "new"} />
        </div>
        <div className={`truncate text-[11px] leading-normal text-[#8b8f98] ${MONO}`}>
          {fileLabel}
          {changed ? " · unsaved" : ""}
        </div>
      </div>

      <div className="flex w-full flex-col gap-3 px-3.5 py-3">
        {byField.general.length > 0 ? <FieldErrors findings={byField.general} /> : null}

        <div className="flex flex-col gap-[5px]">
          <FieldLabel>id</FieldLabel>
          <PipelineIdField
            value={form.id}
            findings={byField.id}
            onCommit={(id) => onDraftChange(setPipelineId(draft, id))}
          />
        </div>

        <div className="flex flex-col gap-[5px]">
          <FieldLabel>default model</FieldLabel>
          <SelectControl
            ariaLabel="Pipeline default model"
            value={form.model ?? ""}
            options={modelOptions}
            error={hasError(byField.model)}
            onChange={(value) => onDraftChange(setPipelineModel(draft, value || null))}
          >
            {form.model ? (
              <span className={`min-w-0 flex-1 truncate text-xs leading-normal text-[#ecedee] ${MONO}`}>
                {form.model}
              </span>
            ) : (
              <>
                <span className="whitespace-nowrap text-xs leading-normal text-[#ecedee]">Inherits default</span>
                <span
                  className={`min-w-0 flex-1 truncate text-right text-[11px] leading-normal text-[#8b8f98] ${MONO}`}
                >
                  {defaultModel ?? "none set"}
                </span>
              </>
            )}
          </SelectControl>
          <FieldErrors findings={byField.model} />
        </div>

        <div className="flex flex-col gap-[5px]">
          <div className="flex items-center gap-2">
            <FieldLabel className="flex-1">stages</FieldLabel>
            <div className={`text-[11px] leading-normal text-[#8b8f98] ${MONO}`}>{form.stages.length}</div>
          </div>
          {form.stages.length === 0 ? (
            <div className="rounded-lg border border-dashed border-[#ffffff1a] px-2.5 py-2 text-xs leading-[1.45] text-[#8b8f98]">
              No stages yet. Add one from the graph or ask the agent.
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              {form.stages.map((stage, i) => {
                const others = ids.filter((id) => id !== stage.id);
                return (
                  <div
                    key={stage.id}
                    className="group flex flex-col gap-1.5 rounded-lg border border-[#ffffff12] bg-[#0f1013] px-2 py-1.5"
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <div className={`w-4 shrink-0 text-[11px] leading-normal text-[#8b8f98] ${MONO}`}>{i + 1}</div>
                      <div className={`min-w-0 flex-1 truncate text-xs leading-normal text-[#ecedee] ${MONO}`}>
                        {stage.id}
                      </div>
                      {stage.entry ? (
                        <span className="inline-flex h-4 shrink-0 items-center rounded-sm border border-[#ffffff1a] px-[5px] text-[10px] font-medium leading-normal text-[#a7aab2]">
                          entry
                        </span>
                      ) : null}
                      <ChangeTag kind={stageChangeKind(draft, baseline, stage.id)} />
                      <div className="flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                        <button
                          type="button"
                          aria-label={`Move ${stage.id} up`}
                          disabled={i === 0}
                          onClick={() => onDraftChange(movePipelineStage(draft, stage.id, -1))}
                          className="flex size-5 items-center justify-center rounded-sm text-[#8b8f98] hover:bg-[#ffffff0d] hover:text-[#ecedee] disabled:opacity-30 disabled:hover:bg-transparent"
                        >
                          <LuChevronUp className="size-3" aria-hidden />
                        </button>
                        <button
                          type="button"
                          aria-label={`Move ${stage.id} down`}
                          disabled={i === form.stages.length - 1}
                          onClick={() => onDraftChange(movePipelineStage(draft, stage.id, 1))}
                          className="flex size-5 items-center justify-center rounded-sm text-[#8b8f98] hover:bg-[#ffffff0d] hover:text-[#ecedee] disabled:opacity-30 disabled:hover:bg-transparent"
                        >
                          <LuChevronDown className="size-3" aria-hidden />
                        </button>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className={`w-[50px] shrink-0 text-[11px] leading-normal text-[#a7aab2] ${MONO}`}>needs</div>
                      <ChipEditor
                        values={stage.needs}
                        addLabel={`Add a stage ${stage.id} needs`}
                        suggestions={others}
                        onAdd={(added) => {
                          const valid = added.filter((id) => others.includes(id));
                          if (valid.length > 0) {
                            onDraftChange(setPipelineStageNeeds(draft, stage.id, [...stage.needs, ...valid]));
                          }
                        }}
                        onRemove={(removed) =>
                          onDraftChange(
                            setPipelineStageNeeds(
                              draft,
                              stage.id,
                              stage.needs.filter((id) => id !== removed),
                            ),
                          )
                        }
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          <FieldErrors findings={byField.stages} />
        </div>

        <div className="flex flex-col gap-1">
          <FieldLabel className="pb-0.5">files</FieldLabel>
          <div className="flex h-[22px] items-center gap-2">
            <div className={`w-[66px] shrink-0 text-[11px] leading-normal text-[#a7aab2] ${MONO}`}>pipeline</div>
            <div className={`min-w-0 truncate text-[11px] leading-normal text-[#ecedee] ${MONO}`} title={fileLabel}>
              {fileLabel}
            </div>
          </div>
          <div className="flex h-[22px] items-center gap-2">
            <div className={`w-[66px] shrink-0 text-[11px] leading-normal text-[#a7aab2] ${MONO}`}>stages</div>
            <div className={`min-w-0 truncate text-[11px] leading-normal text-[#8b8f98] ${MONO}`}>
              {(draft.stages ?? []).length} files · {form.stages.length - form.stages.filter((s) => s.path).length} inline
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
