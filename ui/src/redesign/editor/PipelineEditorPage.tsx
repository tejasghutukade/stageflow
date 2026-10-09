import { useCallback, useEffect, useRef, useState } from "react";
import {
  LuFolder,
  LuPlay,
  LuSquareArrowOutUpRight,
  LuTriangleAlert,
} from "react-icons/lu";
import {
  fetchCatalogValidate,
  fetchModels,
  fetchSettings,
  openDraftPackage,
  overwriteDraftPackageWithDetails,
  validateDraftPackage,
  type DraftPackagePayload,
  type DraftValidationResult,
  type PipelineListing,
  type TaskListing,
  type ValidationFinding,
} from "../../api";
import { newRunPath, workshopPath } from "../../routes";
import { showToast } from "../../toast";
import { ProblemsPanel } from "../ProblemsPanel";
import { Keycap } from "../Keycap";
import { StatusPill } from "../StatusPill";
import { useHotkeys } from "../keys";
import { FilterTabs } from "../shell/FilterTabs";
import { cloneDraft } from "./draftMutators";
import { addStage, renameStage } from "../workshop/stageMutators";
import { stagePathLabel } from "../workshop/inspector/stageFields";
import {
  editorTabSpecs,
  editorValidationPills,
  isDraftDirty,
  isEditorTabId,
  type EditorTabId,
} from "./pipelineEditorModel";
import { PipelineEditorGraph } from "./PipelineEditorGraph";
import { PipelineEditorInspector } from "./PipelineEditorInspector";
import { YamlPanel } from "./YamlPanel";

function defaultTaskForPipeline(
  pipeline: PipelineListing,
  tasks: TaskListing[],
): string | undefined {
  const normalized = pipeline.path.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  const dir = slash >= 0 ? normalized.slice(0, slash) : ".";
  const inDir = tasks.filter((task) =>
    dir === "."
      ? !task.path.includes("/")
      : task.path.startsWith(`${dir}/`),
  );
  return inDir[0]?.path ?? tasks[0]?.path;
}

export type PipelineEditorPageProps = {
  pipelineId: string;
  pipeline: PipelineListing;
  pipelines?: readonly PipelineListing[] | null;
  tasks: TaskListing[];
  onNew: (path: string) => void;
};

export function PipelineEditorPage({
  pipelineId,
  pipeline,
  pipelines = null,
  tasks,
  onNew,
}: PipelineEditorPageProps) {
  const [draft, setDraft] = useState<DraftPackagePayload | null>(null);
  const [baseline, setBaseline] = useState<DraftPackagePayload | null>(null);
  const [destination, setDestination] = useState<{
    directory: string;
    pipelineFilename: string;
  } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedStageId, setSelectedStageId] = useState<string | null>(null);
  const [yamlPath, setYamlPath] = useState<string | null>(pipeline.path);
  const [editorTab, setEditorTab] = useState<EditorTabId>("editor");
  const [autoValidate, setAutoValidate] = useState(true);
  const [draftValidation, setDraftValidation] =
    useState<DraftValidationResult | null>(null);
  const [catalogFindings, setCatalogFindings] = useState<ValidationFinding[]>(
    [],
  );
  const [validating, setValidating] = useState(false);
  const [validateError, setValidateError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [defaultModel, setDefaultModel] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const dirty = isDraftDirty(draft, baseline);

  const reloadDraft = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    const opened = await openDraftPackage({
      path: pipeline.path,
      ...(pipeline.project_root ? { project_root: pipeline.project_root } : {}),
    });
    setLoading(false);
    if (!opened.ok) {
      setLoadError(opened.error);
      setDraft(null);
      setBaseline(null);
      return;
    }
    setDraft(opened.draft);
    setBaseline(cloneDraft(opened.draft));
    setDestination(opened.destination);
    setYamlPath(opened.pipelinePath);
  }, [pipeline.path, pipeline.project_root]);

  useEffect(() => {
    void reloadDraft();
  }, [reloadDraft]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [settings, listed] = await Promise.all([
          fetchSettings(),
          fetchModels(),
        ]);
        if (cancelled) return;
        const trimmed = settings.defaultModel?.trim() ?? "";
        setDefaultModel(trimmed.length > 0 ? trimmed : null);
        setModels(listed.models);
      } catch {
        if (cancelled) return;
        setModels([]);
        setDefaultModel(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const runCatalogValidate = useCallback(async () => {
    setValidating(true);
    setValidateError(null);
    try {
      const result = await fetchCatalogValidate({
        pipeline: pipeline.path,
        strict: true,
        ...(pipeline.project_root
          ? { project_root: pipeline.project_root }
          : {}),
      });
      setCatalogFindings(result.findings);
    } catch (err) {
      setValidateError(err instanceof Error ? err.message : String(err));
    } finally {
      setValidating(false);
    }
  }, [pipeline.path, pipeline.project_root]);

  const runDraftValidate = useCallback(
    async (nextDraft: DraftPackagePayload) => {
      const result = await validateDraftPackage(
        nextDraft,
        pipeline.project_root,
      );
      setDraftValidation(result);
    },
    [pipeline.project_root],
  );

  useEffect(() => {
    void runCatalogValidate();
  }, [runCatalogValidate]);

  useEffect(() => {
    if (!autoValidate || !draft) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void runDraftValidate(draft);
    }, 400);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [autoValidate, draft, runDraftValidate]);

  const onDraftChange = useCallback((next: DraftPackagePayload) => {
    setDraft(next);
  }, []);

  const onDiscard = useCallback(() => {
    void reloadDraft();
    showToast("Discarded local edits");
  }, [reloadDraft]);

  const onSave = useCallback(async () => {
    if (!draft || !destination) return;
    setSaving(true);
    const result = await overwriteDraftPackageWithDetails({
      directory: destination.directory,
      pipelineFilename: destination.pipelineFilename,
      draft,
      ...(pipeline.project_root ? { project_root: pipeline.project_root } : {}),
    });
    setSaving(false);
    if (!result.ok) {
      showToast(result.error ?? "Save failed");
      if (result.findings) setDraftValidation({
        scope: "full",
        ok: false,
        summary: {
          errors: result.findings.filter((f) => f.severity === "error").length,
          warnings: result.findings.filter((f) => f.severity === "warning")
            .length,
        },
        findings: result.findings,
      });
      return;
    }
    setBaseline(cloneDraft(draft));
    showToast("Saved");
    void runCatalogValidate();
  }, [destination, draft, pipeline.project_root, runCatalogValidate]);

  const onAddStage = useCallback(() => {
    if (!draft) return;
    const result = addStage(draft);
    setDraft(result.draft);
    setSelectedStageId(result.stageId);
  }, [draft]);

  const onRenameStage = useCallback(
    (fromId: string, toId: string) => {
      if (!draft) return;
      const previousPath = stagePathLabel(draft, fromId);
      const next = renameStage(draft, fromId, toId);
      if (next === draft) return;
      const nextPath = stagePathLabel(next, toId);
      setDraft(next);
      setSelectedStageId((current) => (current === fromId ? toId : current));
      if (previousPath && nextPath && previousPath !== nextPath) {
        setYamlPath((active) => (active === previousPath ? nextPath : active));
      }
    },
    [draft],
  );

  useHotkeys(
    [
      {
        key: "mod+s",
        scope: "pipelines",
        allowInInput: true,
        handler: (event) => {
          event.preventDefault();
          if (!dirty || saving || !draft) return;
          void onSave();
        },
      },
      {
        key: "a",
        scope: "pipelines",
        when: () => editorTab === "editor" && !!draft && !loading,
        handler: (event) => {
          event.preventDefault();
          onAddStage();
        },
      },
    ],
    "pipelines",
  );

  const defaultTask = defaultTaskForPipeline(pipeline, tasks);
  const pills = editorValidationPills(draftValidation);
  const saveDisabled = !dirty || saving || loading || !draft;

  const copyPath = useCallback(() => {
    void navigator.clipboard.writeText(pipeline.path).then(
      () => showToast("Copied path"),
      () => showToast("Could not copy path"),
    );
  }, [pipeline.path]);

  return (
    <div className="flex min-h-screen min-w-0 flex-col">
      <div className="flex w-full shrink-0 items-center justify-between gap-3 border-b border-b-[#ffffff12] px-5 py-2">
        <div className="flex min-w-0 flex-col justify-center gap-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <a
              href="#/pipelines"
              className="text-[13px] text-[var(--sf-text-2)] hover:text-[var(--sf-text-1)]"
            >
              Pipelines
            </a>
            <span className="text-[13px] text-[var(--sf-text-3)]">/</span>
            <span className="truncate text-[13px] font-medium text-[var(--sf-text-1)]">
              {pipelineId}
            </span>
          </div>
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="truncate text-[18px] font-semibold tracking-[-0.4px] text-[var(--sf-text-1)]">
              {pipelineId}
            </h1>
            <button
              type="button"
              onClick={copyPath}
              title={pipeline.path}
              className="inline-flex max-w-[360px] min-w-0 items-center gap-1.5 rounded-md border border-[#ffffff1a] bg-[var(--sf-raised)] px-2 py-0.5 font-['Geist_Mono',monospace] text-[11px] text-[var(--sf-text-2)] hover:text-[var(--sf-text-1)]"
            >
              <LuFolder className="size-3 shrink-0" aria-hidden />
              <span className="truncate">{pipeline.path}</span>
            </button>
            {dirty ? (
              <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-[#f5b544]">
                <span className="size-1.5 rounded-full bg-[#f5b544]" aria-hidden />
                Unsaved changes
              </span>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {pills ? (
            <>
              <StatusPill signal={pills.strictSignal} label={pills.strictLabel} />
              <span
                className={`flex h-6 items-center gap-[5px] rounded-full px-2 ${
                  pills.warningSignal === "needs"
                    ? "border border-[#f5b5444d] bg-[#f5b5441f] text-[var(--sf-needs)]"
                    : "bg-[var(--sf-raised)] text-[var(--sf-text-3)]"
                }`}
                aria-label={pills.warningLabel}
              >
                {pills.warningCount > 0 ? (
                  <LuTriangleAlert className="size-3 shrink-0 text-[#f5b544]" aria-hidden />
                ) : null}
                <span className="font-sans text-xs font-medium">{pills.warningLabel}</span>
              </span>
            </>
          ) : null}
          <button
            type="button"
            className="sf-btn sf-btn--ghost"
            disabled={!dirty || loading}
            onClick={onDiscard}
          >
            Discard
          </button>
          <a
            className="sf-btn sf-btn--secondary"
            href={`#${workshopPath({
              pipeline: pipeline.path,
              ...(pipeline.project_root
                ? { project_root: pipeline.project_root }
                : {}),
            })}`}
          >
            <LuSquareArrowOutUpRight className="size-3.5" aria-hidden />
            Open in Workshop
          </a>
          <button
            type="button"
            className="sf-btn sf-btn--secondary"
            onClick={() =>
              onNew(
                newRunPath({
                  pipeline: pipeline.path,
                  ...(defaultTask ? { task: defaultTask } : {}),
                }),
              )
            }
          >
            <LuPlay className="size-3.5" aria-hidden />
            Start a run
          </button>
          <button
            type="button"
            className="sf-btn sf-btn--primary"
            disabled={saveDisabled}
            onClick={() => void onSave()}
          >
            Save
            <Keycap className="border-[#0c0d0f33] text-[#5a5e66]">⌘S</Keycap>
          </button>
        </div>
      </div>
      <div className="relative">
        <FilterTabs
          variant="underline"
          tabs={editorTabSpecs(0)}
          activeId={editorTab}
          onChange={(id) => {
            if (isEditorTabId(id)) setEditorTab(id);
          }}
        />
        <button
          type="button"
          role="switch"
          aria-checked={autoValidate}
          aria-label="Auto-validate"
          onClick={() => setAutoValidate((on) => !on)}
          className="absolute right-7 top-1/2 flex -translate-y-1/2 items-center gap-[7px] rounded-md py-1 pr-1"
        >
          <span
            className={`flex h-4 w-[26px] items-center rounded-full px-0.5 ${
              autoValidate ? "bg-[var(--sf-text-1)]" : "bg-[var(--sf-raised)]"
            }`}
          >
            <span
              className={`block size-3 rounded-full transition-transform ${
                autoValidate
                  ? "translate-x-[10px] bg-[var(--sf-ground)]"
                  : "bg-[var(--sf-text-3)]"
              }`}
            />
          </span>
          <span className="whitespace-nowrap text-xs text-[var(--sf-text-2)]">
            Auto-validate
          </span>
        </button>
      </div>
      {editorTab === "runs" ? (
        <div
          role="tabpanel"
          aria-label="Runs"
          className="flex min-h-0 flex-1 flex-col"
        >
          <div className="flex h-9 items-center gap-6 border-b border-b-[#ffffff12] px-5 text-[11px] uppercase tracking-[0.04em] text-[var(--sf-text-3)]">
            <span className="w-40">Run</span>
            <span className="w-28">Status</span>
            <span>Task</span>
          </div>
          <p className="px-5 py-6 text-[13px] text-[var(--sf-text-3)]">No runs</p>
        </div>
      ) : null}
      {editorTab === "history" ? (
        <div
          role="tabpanel"
          aria-label="History"
          className="flex min-h-0 flex-1 flex-col px-5 py-6"
        >
          <p className="text-[13px] text-[var(--sf-text-3)]">No history</p>
        </div>
      ) : null}
      {editorTab === "editor" && loadError ? (
        <p className="px-5 pt-3 text-[13px] text-[var(--sf-fail)]">{loadError}</p>
      ) : null}
      {editorTab === "editor" && loading ? (
        <p className="px-5 py-4 text-[13px] text-[var(--sf-text-3)]">
          Loading package…
        </p>
      ) : null}
      {editorTab === "editor" && !loading && draft ? (
        <div className="flex min-h-0 flex-1 flex-col" role="tabpanel" aria-label="Editor">
          <div className="flex min-h-0 w-full min-w-0 flex-1 overflow-hidden">
            <YamlPanel
              draft={draft}
              pipelinePath={pipeline.path}
              projectRoot={pipeline.project_root}
              activePath={yamlPath}
              onActivePathChange={setYamlPath}
            />
            <PipelineEditorGraph
              draft={draft}
              selectedStageId={selectedStageId}
              onSelectStage={setSelectedStageId}
              onAddStage={onAddStage}
            />
            <PipelineEditorInspector
              draft={draft}
              baseline={baseline}
              selectedStageId={selectedStageId}
              findings={draftValidation?.findings ?? []}
              models={models}
              defaultModel={defaultModel}
              pipelines={pipelines}
              projectRoot={pipeline.project_root}
              onDraftChange={onDraftChange}
              onRenameStage={onRenameStage}
            />
          </div>
          <ProblemsPanel
            findings={catalogFindings}
            activeFilePath={yamlPath}
            loading={validating}
            error={validateError}
            onValidate={() => {
              void runCatalogValidate();
              if (draft) void runDraftValidate(draft);
            }}
          />
        </div>
      ) : null}
    </div>
  );
}
