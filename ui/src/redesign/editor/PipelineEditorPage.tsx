import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  fetchCatalogValidate,
  fetchModels,
  fetchSettings,
  fetchSkills,
  openDraftPackage,
  overwriteDraftPackageWithDetails,
  validateDraftPackage,
  type DraftPackagePayload,
  type DraftValidationResult,
  type PipelineListing,
  type TaskListing,
  type ValidationFinding,
} from "../../api";
import { useRunCatalog } from "../../catalog/useRunCatalog";
import { newRunPath, workshopPath } from "../../routes";
import { showToast } from "../../toast";
import { useHotkeys } from "../keys";
import { cloneDraft } from "./draftMutators";
import { addStage, renameStage } from "../workshop/stageMutators";
import { stagePathLabel } from "../workshop/inspector/stageFields";
import type { StageFocusRequest } from "../workshop/inspector/WorkshopStageInspector";
import {
  filterEditorPipelineRuns,
  isDraftDirty,
  mergeEditorFindings,
  type EditorHistorySessionEvent,
  type EditorTabId,
} from "./pipelineEditorModel";
import { PipelineEditorGraph } from "./PipelineEditorGraph";
import { PipelineEditorHeader } from "./PipelineEditorHeader";
import { PipelineEditorHistory } from "./PipelineEditorHistory";
import { PipelineEditorRuns } from "./PipelineEditorRuns";
import { PipelineEditorInspector } from "./PipelineEditorInspector";
import { EditorProblemsPanel } from "./EditorProblemsPanel";
import {
  normalizeYamlPath,
  yamlPathForSelectedStage,
  yamlPathsMatch,
} from "./draftYaml";
import { unsavedChangeCount } from "./editorHeaderModel";
import { EditorColumnResizeHandle } from "./EditorColumnResizeHandle";
import {
  EDITOR_INSPECTOR_DEFAULT_WIDTH,
  EDITOR_INSPECTOR_MAX_WIDTH,
  EDITOR_INSPECTOR_MIN_WIDTH,
  EDITOR_YAML_DEFAULT_WIDTH,
  EDITOR_YAML_MAX_WIDTH,
  EDITOR_YAML_MIN_WIDTH,
  clampEditorInspectorWidth,
  clampEditorYamlWidth,
  draftSchemaCount,
  editorDirtyPaths,
  editorFindingTarget,
  editorHeaderPills,
  editorPanelFindings,
  editorStageFindings,
} from "./editorPageModel";
import {
  editorFindingKey,
  quickFixLabel,
  type EditorFinding,
} from "./editorProblemsModel";
import { useEditorStageStats } from "./useEditorStageStats";
import { isPipelineYamlPath, type YamlParseError } from "./yamlEditorModel";
import { YamlPanel } from "./YamlPanel";

function editorPipelineKey(pipeline: {
  id: string;
  path: string;
  project_root?: string;
}): string {
  return `${pipeline.id}\0${pipeline.project_root ?? ""}\0${pipeline.path}`;
}

function historyValidationDetail(
  source: "draft" | "catalog",
  result: DraftValidationResult,
): string {
  const errors =
    result.summary.errors === 1 ? "1 error" : `${result.summary.errors} errors`;
  const warnings =
    result.summary.warnings === 1
      ? "1 warning"
      : `${result.summary.warnings} warnings`;
  const outcome = result.ok ? "valid" : errors;
  return result.summary.warnings > 0
    ? `${source} · ${outcome} · ${warnings}`
    : `${source} · ${outcome}`;
}

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
  const [openPaths, setOpenPaths] = useState<string[]>([pipeline.path]);
  const [yamlParseError, setYamlParseError] = useState<YamlParseError | null>(null);
  const [yamlKey, setYamlKey] = useState(0);
  const [formatNonce, setFormatNonce] = useState(0);
  const [yamlWidth, setYamlWidth] = useState(EDITOR_YAML_DEFAULT_WIDTH);
  const [inspectorWidth, setInspectorWidth] = useState(
    EDITOR_INSPECTOR_DEFAULT_WIDTH,
  );
  const [editorTab, setEditorTab] = useState<EditorTabId>("editor");
  const [autoValidate, setAutoValidate] = useState(true);
  const [draftValidation, setDraftValidation] =
    useState<DraftValidationResult | null>(null);
  const [catalogFindings, setCatalogFindings] = useState<ValidationFinding[]>(
    [],
  );
  const [validating, setValidating] = useState(false);
  const [validateError, setValidateError] = useState<string | null>(null);
  const [validatedMs, setValidatedMs] = useState<number | null>(null);
  const [validatedAt, setValidatedAt] = useState<number | null>(null);
  const [problemsCollapsed, setProblemsCollapsed] = useState(false);
  const [selectedProblemKey, setSelectedProblemKey] = useState<string | null>(null);
  const [fieldFocus, setFieldFocus] = useState<
    (StageFocusRequest & { stageId: string }) | null
  >(null);
  const focusNonce = useRef(0);
  const [saving, setSaving] = useState(false);
  const [sessionEvents, setSessionEvents] = useState<
    Array<EditorHistorySessionEvent & { pipelineKey: string }>
  >([]);
  const sessionSeq = useRef(0);
  const pipelineKey = editorPipelineKey(pipeline);
  const [models, setModels] = useState<string[]>([]);
  const [defaultModel, setDefaultModel] = useState<string | null>(null);
  const [skills, setSkills] = useState<string[]>([]);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftValidateGen = useRef(0);
  const catalogValidateGen = useRef(0);

  const pipelinePath = pipeline.path;
  const dirty = isDraftDirty(draft, baseline);
  const unsavedCount = unsavedChangeCount(draft, baseline);
  const dirtyPaths = useMemo(
    () => editorDirtyPaths(draft, baseline, pipelinePath),
    [baseline, draft, pipelinePath],
  );
  const {
    snapshot: runSnapshot,
    error: runsError,
    loading: runsLoading,
  } = useRunCatalog();
  const pipelineRuns = useMemo(
    () =>
      filterEditorPipelineRuns(runSnapshot.runs, {
        id: pipeline.id,
        project_root: pipeline.project_root,
      }),
    [pipeline.id, pipeline.project_root, runSnapshot.runs],
  );
  const { stageStats, p50Ms } = useEditorStageStats(pipelineRuns);
  const historyEvents = useMemo(
    () => sessionEvents.filter((event) => event.pipelineKey === pipelineKey),
    [pipelineKey, sessionEvents],
  );

  const appendSession = useCallback(
    (label: string, detail?: string) => {
      const id = `session-${sessionSeq.current}`;
      sessionSeq.current += 1;
      setSessionEvents((current) => [
        ...current,
        {
          pipelineKey,
          id,
          at: new Date().toISOString(),
          label,
          ...(detail ? { detail } : {}),
        },
      ]);
    },
    [pipelineKey],
  );

  const reloadDraft = useCallback(async () => {
    draftValidateGen.current += 1;
    catalogValidateGen.current += 1;
    setDraftValidation(null);
    setCatalogFindings([]);
    setValidateError(null);
    setSelectedProblemKey(null);
    setYamlParseError(null);
    setYamlKey((key) => key + 1);
    setOpenPaths([pipeline.path]);
    setYamlPath(pipeline.path);
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

  useEffect(() => {
    let cancelled = false;
    fetchSkills().then(
      (listed) => {
        if (!cancelled) setSkills(listed.skills.map((skill) => skill.name));
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const runCatalogValidate = useCallback(async () => {
    const generation = ++catalogValidateGen.current;
    setValidating(true);
    setValidateError(null);
    try {
      const started = Date.now();
      const result = await fetchCatalogValidate({
        pipeline: pipeline.path,
        strict: true,
        ...(pipeline.project_root
          ? { project_root: pipeline.project_root }
          : {}),
      });
      if (generation !== catalogValidateGen.current) return;
      setCatalogFindings(result.findings);
      setValidatedMs(Date.now() - started);
      setValidatedAt(Date.now());
      appendSession("Validated", historyValidationDetail("catalog", result));
    } catch (err) {
      if (generation !== catalogValidateGen.current) return;
      setValidateError(err instanceof Error ? err.message : String(err));
    } finally {
      if (generation === catalogValidateGen.current) setValidating(false);
    }
  }, [appendSession, pipeline.path, pipeline.project_root]);

  const runDraftValidate = useCallback(
    async (nextDraft: DraftPackagePayload) => {
      const generation = ++draftValidateGen.current;
      const started = Date.now();
      const result = await validateDraftPackage(
        nextDraft,
        pipeline.project_root,
      );
      if (generation !== draftValidateGen.current) return;
      setDraftValidation(result);
      setValidatedMs(Date.now() - started);
      setValidatedAt(Date.now());
      appendSession("Validated", historyValidationDetail("draft", result));
    },
    [appendSession, pipeline.project_root],
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
    void runCatalogValidate();
    showToast("Discarded local edits");
  }, [reloadDraft, runCatalogValidate]);

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
    appendSession("Saved");
    void runCatalogValidate();
  }, [appendSession, destination, draft, pipeline.project_root, runCatalogValidate]);

  const openYamlPath = useCallback((path: string) => {
    setOpenPaths((current) =>
      current.some((open) => normalizeYamlPath(open) === normalizeYamlPath(path))
        ? current
        : [...current, path],
    );
    setYamlPath(path);
  }, []);

  const showStageYaml = useCallback(
    (nextDraft: DraftPackagePayload, stageId: string) => {
      const path = yamlPathForSelectedStage(nextDraft, stageId);
      if (path) openYamlPath(path);
      else setYamlPath(pipelinePath);
    },
    [openYamlPath, pipelinePath],
  );

  const onClosePath = useCallback(
    (path: string) => {
      const key = normalizeYamlPath(path);
      setOpenPaths((current) => current.filter((open) => normalizeYamlPath(open) !== key));
      setYamlPath((active) =>
        active && normalizeYamlPath(active) === key ? pipelinePath : active,
      );
    },
    [pipelinePath],
  );

  const onOpenYaml = useCallback(
    (path: string) => {
      if (!path || isPipelineYamlPath(path, pipelinePath)) setYamlPath(pipelinePath);
      else openYamlPath(path);
    },
    [openYamlPath, pipelinePath],
  );

  const onSelectStage = useCallback(
    (stageId: string) => {
      setSelectedStageId(stageId);
      if (draft) showStageYaml(draft, stageId);
    },
    [draft, showStageYaml],
  );

  const onAddStage = useCallback(() => {
    if (!draft) return;
    const result = addStage(draft);
    setDraft(result.draft);
    setSelectedStageId(result.stageId);
    showStageYaml(result.draft, result.stageId);
  }, [draft, showStageYaml]);

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
        setOpenPaths((current) =>
          current.map((open) => (yamlPathsMatch(open, previousPath) ? nextPath : open)),
        );
        setYamlPath((active) =>
          active && yamlPathsMatch(active, previousPath) ? nextPath : active,
        );
      }
    },
    [draft],
  );

  const backendFindings = useMemo(
    () => mergeEditorFindings(draftValidation?.findings ?? [], catalogFindings),
    [catalogFindings, draftValidation],
  );
  const findings = useMemo(
    () =>
      draft ? editorPanelFindings(draft, pipelinePath, backendFindings, yamlParseError) : [],
    [backendFindings, draft, pipelinePath, yamlParseError],
  );
  const stageFindings = useMemo(() => editorStageFindings(findings), [findings]);
  const selectedFinding = selectedProblemKey
    ? (findings.find((row) => editorFindingKey(row) === selectedProblemKey) ?? null)
    : null;

  const quickFixFor = useCallback(
    (finding: EditorFinding) => (draft ? quickFixLabel(finding, draft) : undefined),
    [draft],
  );

  const selectFinding = useCallback(
    (finding: EditorFinding) => {
      setSelectedProblemKey(editorFindingKey(finding));
      if (!draft) return;
      const target = editorFindingTarget(finding, draft);
      if (target) {
        setSelectedStageId(target.stageId);
        showStageYaml(draft, target.stageId);
      }
      if (isPipelineYamlPath(finding.path, pipelinePath)) {
        setYamlPath(pipelinePath);
        return;
      }
      const file = (draft.stages ?? []).find((entry) => yamlPathsMatch(entry.path, finding.path));
      if (file) openYamlPath(file.path);
    },
    [draft, openYamlPath, pipelinePath, showStageYaml],
  );

  const applyQuickFix = useCallback(
    (finding: EditorFinding) => {
      selectFinding(finding);
      setProblemsCollapsed(false);
      if (!draft) return;
      const target = editorFindingTarget(finding, draft);
      if (!target?.field) return;
      focusNonce.current += 1;
      setFieldFocus({
        stageId: target.stageId,
        field: target.field,
        nonce: focusNonce.current,
      });
    },
    [draft, selectFinding],
  );

  const saveDisabled = !dirty || saving || loading || !draft || yamlParseError !== null;

  useHotkeys(
    [
      {
        key: "mod+s",
        scope: "pipelines",
        allowInInput: true,
        handler: (event) => {
          event.preventDefault();
          if (saveDisabled) return;
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
      {
        key: "alt+shift+f",
        scope: "pipelines",
        allowInInput: true,
        when: () => editorTab === "editor" && !!draft && !loading,
        handler: (event) => {
          event.preventDefault();
          if (yamlParseError) return;
          setFormatNonce((nonce) => nonce + 1);
        },
      },
      {
        key: "mod+.",
        scope: "pipelines",
        allowInInput: true,
        when: () => editorTab === "editor" && !loading,
        handler: (event) => {
          event.preventDefault();
          const target =
            selectedFinding && quickFixFor(selectedFinding)
              ? selectedFinding
              : findings.find((row) => quickFixFor(row));
          if (!target) return;
          applyQuickFix(target);
        },
      },
    ],
    "pipelines",
  );

  const defaultTask = defaultTaskForPipeline(pipeline, tasks);
  const pills = editorHeaderPills(draftValidation, yamlParseError !== null);
  const workshopHref = `#${workshopPath({
    pipeline: pipeline.path,
    ...(pipeline.project_root ? { project_root: pipeline.project_root } : {}),
  })}`;

  const copyPath = useCallback(() => {
    void navigator.clipboard.writeText(pipeline.path).then(
      () => showToast("Copied path"),
      () => showToast("Could not copy path"),
    );
  }, [pipeline.path]);

  const selectedFixLabel = selectedFinding ? quickFixFor(selectedFinding) : undefined;
  const yamlFinding =
    selectedFinding && selectedFinding.severity !== "info"
      ? {
          path: selectedFinding.path,
          message: selectedFinding.message,
          severity: selectedFinding.severity,
          code: selectedFinding.code,
          ...(selectedFinding.line !== undefined ? { line: selectedFinding.line } : {}),
          ...(selectedFinding.column !== undefined ? { column: selectedFinding.column } : {}),
          ...(selectedFixLabel ? { quickFixLabel: selectedFixLabel } : {}),
        }
      : null;
  const infoRange =
    selectedFinding?.severity === "info" && selectedFinding.line !== undefined
      ? { start: selectedFinding.line, end: selectedFinding.lineEnd ?? selectedFinding.line }
      : undefined;

  return (
    <div className="flex h-screen min-w-0 flex-1 flex-col overflow-hidden">
      <PipelineEditorHeader
        pipelineId={pipelineId}
        filePath={pipeline.path}
        unsavedCount={unsavedCount}
        pills={pills}
        discardDisabled={loading || (unsavedCount === 0 && yamlParseError === null)}
        saveDisabled={saveDisabled}
        saving={saving}
        workshopHref={workshopHref}
        onDiscard={onDiscard}
        onStartRun={() =>
          onNew(
            newRunPath({
              pipeline: pipeline.path,
              ...(defaultTask ? { task: defaultTask } : {}),
              ...(pipeline.project_root ? { project_root: pipeline.project_root } : {}),
            }),
          )
        }
        onSave={() => void onSave()}
        onCopyPath={copyPath}
        activeTab={editorTab}
        onTabChange={setEditorTab}
        runsCount={runsLoading ? null : pipelineRuns.length}
        autoValidate={autoValidate}
        onAutoValidateChange={setAutoValidate}
        onFormat={() => setFormatNonce((nonce) => nonce + 1)}
        formatDisabled={yamlParseError !== null || !draft || loading}
      />
      {editorTab === "runs" ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <PipelineEditorRuns runs={pipelineRuns} loading={runsLoading} error={runsError} />
        </div>
      ) : null}
      {editorTab === "history" ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <PipelineEditorHistory events={historyEvents} runs={pipelineRuns} loading={runsLoading} />
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
        <>
          <div className="flex min-h-0 flex-1" role="tabpanel" aria-label="Editor">
            <YamlPanel
              key={yamlKey}
              draft={draft}
              pipelinePath={pipelinePath}
              activePath={yamlPath}
              onActivePathChange={setYamlPath}
              openPaths={openPaths}
              onClosePath={onClosePath}
              dirtyPaths={dirtyPaths}
              highlightRange={infoRange}
              selectedStageId={selectedStageId}
              activeFinding={yamlFinding}
              onQuickFix={() => {
                if (selectedFinding) applyQuickFix(selectedFinding);
              }}
              onDraftChange={onDraftChange}
              onParseError={setYamlParseError}
              formatNonce={formatNonce}
              readOnly={false}
              width={yamlWidth}
            />
            <EditorColumnResizeHandle
              label="Resize YAML panel"
              value={yamlWidth}
              min={EDITOR_YAML_MIN_WIDTH}
              max={EDITOR_YAML_MAX_WIDTH}
              onChange={(next) => setYamlWidth(clampEditorYamlWidth(next))}
            />
            <PipelineEditorGraph
              draft={draft}
              selectedStageId={selectedStageId}
              onSelectStage={onSelectStage}
              onAddStage={onAddStage}
              defaultModel={defaultModel}
              stageFindings={stageFindings}
              stageStats={stageStats}
              p50Ms={p50Ms}
            />
            <EditorColumnResizeHandle
              label="Resize stage inspector"
              value={inspectorWidth}
              min={EDITOR_INSPECTOR_MIN_WIDTH}
              max={EDITOR_INSPECTOR_MAX_WIDTH}
              invert
              onChange={(next) =>
                setInspectorWidth(clampEditorInspectorWidth(next))
              }
            />
            <PipelineEditorInspector
              draft={draft}
              baseline={baseline}
              selectedStageId={selectedStageId}
              findings={backendFindings}
              models={models}
              defaultModel={defaultModel}
              skills={skills}
              pipelines={pipelines}
              currentPipelineId={pipeline.id}
              projectRoot={pipeline.project_root}
              workshopHref={workshopHref}
              onDraftChange={onDraftChange}
              onRenameStage={onRenameStage}
              onOpenYaml={onOpenYaml}
              width={inspectorWidth}
              focusRequest={
                fieldFocus && fieldFocus.stageId === selectedStageId
                  ? { field: fieldFocus.field, nonce: fieldFocus.nonce }
                  : null
              }
            />
          </div>
          <EditorProblemsPanel
            findings={findings}
            activeFilePath={yamlPath}
            loading={validating}
            error={validateError}
            collapsed={problemsCollapsed}
            onCollapsedChange={setProblemsCollapsed}
            selectedKey={selectedProblemKey}
            onSelectFinding={selectFinding}
            onQuickFix={applyQuickFix}
            onValidate={() => {
              void runCatalogValidate();
              if (draft) void runDraftValidate(draft);
            }}
            validatedAt={validatedAt}
            validatedMs={validatedMs}
            stageCount={draft.pipeline.stages.length}
            schemaCount={draftSchemaCount(draft)}
            findingKey={editorFindingKey}
            quickFixFor={quickFixFor}
          />
        </>
      ) : null}
    </div>
  );
}
