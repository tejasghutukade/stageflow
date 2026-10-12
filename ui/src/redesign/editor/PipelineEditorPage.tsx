import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createDraftPackageWithDetails,
  fetchCatalogFile,
  fetchCatalogValidate,
  fetchModels,
  fetchSettings,
  fetchSkills,
  openDraftPackage,
  overwriteDraftPackageWithDetails,
  validateDraftPackage,
  writeCatalogFile,
  type DraftPackagePayload,
  type DraftValidationResult,
  type PipelineListing,
  type TaskListing,
  type ValidationFinding,
} from "../../api";
import { displayCatalogPath } from "../../catalog/displayCatalogPath";
import { useRunCatalog } from "../../catalog/useRunCatalog";
import { newRunPath, workshopPath } from "../../routes";
import { showToast } from "../../toast";
import { useHotkeys } from "../keys";
import { cloneDraft } from "./draftMutators";
import { addStage, renameStage } from "../workshop/stageMutators";
import {
  DEFAULT_WRITE_CATALOG_WIRE_ID,
  defaultPackageDirectory,
  draftOriginFromResponse,
  omitDefaultWriteProjectRoot,
  type DraftOrigin,
} from "../workshop/workshopPageModel";
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
  draftFileYaml,
  normalizeYamlPath,
  serializeYamlDocument,
  yamlPathForSelectedStage,
  yamlPathsMatch,
} from "./draftYaml";
import {
  editorReadOnlyNotice,
  editorSaveLabel,
  unsavedChangeCount,
} from "./editorHeaderModel";
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
import { buildStageDraftPackage } from "./stageDraftPackage";
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
  mode?: "pipeline" | "stage";
  stagePath?: string;
  projectRoot?: string;
};

function stageBufferYaml(
  draft: DraftPackagePayload,
  stageFilePath: string,
): string {
  const file = (draft.stages ?? []).find((entry) =>
    yamlPathsMatch(entry.path, stageFilePath),
  );
  if (file) return serializeYamlDocument(file.body);
  return draftFileYaml(draft, stageFilePath, null);
}

export function PipelineEditorPage({
  pipelineId,
  pipeline,
  pipelines = null,
  tasks,
  onNew,
  mode = "pipeline",
  stagePath: stagePathProp,
  projectRoot: projectRootProp,
}: PipelineEditorPageProps) {
  const stageMode = mode === "stage";
  const stageFilePath = stagePathProp
    ? normalizeYamlPath(stagePathProp)
    : normalizeYamlPath(pipeline.path);
  const [draft, setDraft] = useState<DraftPackagePayload | null>(null);
  const [baseline, setBaseline] = useState<DraftPackagePayload | null>(null);
  const [destination, setDestination] = useState<{
    directory: string;
    pipelineFilename: string;
  } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedStageId, setSelectedStageId] = useState<string | null>(null);
  const [yamlPath, setYamlPath] = useState<string | null>(
    stageMode ? stageFilePath : pipeline.path,
  );
  const [openPaths, setOpenPaths] = useState<string[]>(
    stageMode ? [stageFilePath] : [pipeline.path],
  );
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
  const [sourceOrigin, setSourceOrigin] = useState<DraftOrigin | null>(null);
  const catalogProjectRoot = projectRootProp ?? pipeline.project_root;
  const readOnlySource = !stageMode && sourceOrigin?.readOnly === true;
  const [models, setModels] = useState<string[]>([]);
  const [defaultModel, setDefaultModel] = useState<string | null>(null);
  const [skills, setSkills] = useState<string[]>([]);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftValidateGen = useRef(0);
  const catalogValidateGen = useRef(0);

  // Must not equal the stage file path — YamlPanel routes pipeline vs stage edits by path.
  const pipelinePath = stageMode
    ? `${stageFilePath}.stage-editor.pipeline.yaml`
    : pipeline.path;
  const headerId = stageMode
    ? (selectedStageId ?? draft?.pipeline.id ?? pipelineId)
    : pipelineId;
  const headerFilePath = stageMode
    ? displayCatalogPath(stageFilePath, catalogProjectRoot)
    : pipeline.path;

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
    setLoading(true);
    setLoadError(null);
    if (stageMode) {
      setOpenPaths([stageFilePath]);
      setYamlPath(stageFilePath);
      try {
        const file = await fetchCatalogFile({
          path: stageFilePath,
          ...(catalogProjectRoot ? { project_root: catalogProjectRoot } : {}),
        });
        const pkg = buildStageDraftPackage(
          stageFilePath,
          file.content,
          catalogProjectRoot,
        );
        setDraft(pkg.draft);
        setBaseline(cloneDraft(pkg.draft));
        setDestination(null);
        setSourceOrigin(null);
        setSelectedStageId(pkg.stageId);
        setLoading(false);
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : String(err));
        setDraft(null);
        setBaseline(null);
        setLoading(false);
      }
      return;
    }
    setOpenPaths([pipeline.path]);
    setYamlPath(pipeline.path);
    const opened = await openDraftPackage({
      path: pipeline.path,
      ...(catalogProjectRoot ? { project_root: catalogProjectRoot } : {}),
    });
    setLoading(false);
    if (!opened.ok) {
      setLoadError(opened.error);
      setDraft(null);
      setBaseline(null);
      return;
    }
    const origin = draftOriginFromResponse(opened);
    if (origin) setSourceOrigin(origin);
    setDraft(opened.draft);
    setBaseline(cloneDraft(opened.draft));
    setDestination(opened.destination);
  }, [catalogProjectRoot, pipeline.path, stageFilePath, stageMode]);

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
    if (stageMode) return;
    const generation = ++catalogValidateGen.current;
    setValidating(true);
    setValidateError(null);
    try {
      const started = Date.now();
      const result = await fetchCatalogValidate({
        pipeline: pipeline.path,
        strict: true,
        ...(catalogProjectRoot ? { project_root: catalogProjectRoot } : {}),
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
  }, [appendSession, catalogProjectRoot, pipeline.path, stageMode]);

  const runDraftValidate = useCallback(
    async (nextDraft: DraftPackagePayload) => {
      if (stageMode) {
        const generation = ++catalogValidateGen.current;
        setValidating(true);
        setValidateError(null);
        try {
          const started = Date.now();
          const result = await fetchCatalogValidate({
            stage: stageFilePath,
            content: stageBufferYaml(nextDraft, stageFilePath),
            strict: true,
            ...(catalogProjectRoot ? { project_root: catalogProjectRoot } : {}),
          });
          if (generation !== catalogValidateGen.current) return;
          setCatalogFindings(result.findings);
          setDraftValidation(result);
          setValidatedMs(Date.now() - started);
          setValidatedAt(Date.now());
          appendSession("Validated", historyValidationDetail("catalog", result));
        } catch (err) {
          if (generation !== catalogValidateGen.current) return;
          setValidateError(err instanceof Error ? err.message : String(err));
        } finally {
          if (generation === catalogValidateGen.current) setValidating(false);
        }
        return;
      }
      const generation = ++draftValidateGen.current;
      const started = Date.now();
      const result = await validateDraftPackage(nextDraft, catalogProjectRoot);
      if (generation !== draftValidateGen.current) return;
      setDraftValidation(result);
      setValidatedMs(Date.now() - started);
      setValidatedAt(Date.now());
      appendSession("Validated", historyValidationDetail("draft", result));
    },
    [appendSession, catalogProjectRoot, stageFilePath, stageMode],
  );

  useEffect(() => {
    if (stageMode) return;
    void runCatalogValidate();
  }, [runCatalogValidate, stageMode]);

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
    if (!stageMode) void runCatalogValidate();
    showToast("Discarded local edits");
  }, [reloadDraft, runCatalogValidate, stageMode]);

  const onSave = useCallback(async () => {
    if (!draft) return;
    setSaving(true);
    if (stageMode) {
      const content = stageBufferYaml(draft, stageFilePath);
      const result = await writeCatalogFile({
        path: stageFilePath,
        content,
        ...(catalogProjectRoot ? { project_root: catalogProjectRoot } : {}),
      });
      setSaving(false);
      if (!result.ok) {
        showToast(result.error ?? "Save failed");
        if (result.findings) {
          setCatalogFindings(result.findings);
          setDraftValidation({
            scope: "full",
            ok: false,
            summary: {
              errors: result.findings.filter((f) => f.severity === "error")
                .length,
              warnings: result.findings.filter((f) => f.severity === "warning")
                .length,
            },
            findings: result.findings,
          });
          setProblemsCollapsed(false);
        }
        return;
      }
      let nextDraft = draft;
      try {
        const pkg = buildStageDraftPackage(
          stageFilePath,
          result.content,
          catalogProjectRoot,
        );
        nextDraft = pkg.draft;
        setDraft(pkg.draft);
        setBaseline(cloneDraft(pkg.draft));
        setSelectedStageId(pkg.stageId);
        setOpenPaths([stageFilePath]);
        setYamlPath(stageFilePath);
        setYamlKey((key) => key + 1);
      } catch {
        setBaseline(cloneDraft(draft));
      }
      showToast("Saved");
      appendSession("Saved");
      void runDraftValidate(nextDraft);
      return;
    }
    let result;
    if (readOnlySource) {
      const directory = defaultPackageDirectory("workspace", draft.pipeline.id);
      result = await createDraftPackageWithDetails({
        directory,
        pipelineFilename: destination?.pipelineFilename,
        draft,
        ...omitDefaultWriteProjectRoot(
          DEFAULT_WRITE_CATALOG_WIRE_ID,
          DEFAULT_WRITE_CATALOG_WIRE_ID,
        ),
      });
      if (!result.ok && result.status === 409) {
        const nextId = window.prompt(
          "A pipeline with this id already exists in Workspace. Enter a new pipeline id:",
          `${draft.pipeline.id}-copy`,
        );
        if (nextId?.trim()) {
          const renamed = { ...draft, pipeline: { ...draft.pipeline, id: nextId.trim() } };
          result = await createDraftPackageWithDetails({
            directory: defaultPackageDirectory("workspace", nextId.trim()),
            draft: renamed,
            ...omitDefaultWriteProjectRoot(
              DEFAULT_WRITE_CATALOG_WIRE_ID,
              DEFAULT_WRITE_CATALOG_WIRE_ID,
            ),
          });
          if (result.ok) setDraft(renamed);
        }
      }
    } else {
      if (!destination) {
        setSaving(false);
        return;
      }
      result = await overwriteDraftPackageWithDetails({
        directory: destination.directory,
        pipelineFilename: destination.pipelineFilename,
        draft,
        ...(catalogProjectRoot ? { project_root: catalogProjectRoot } : {}),
      });
    }
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
    const nextOrigin = draftOriginFromResponse(result);
    if (nextOrigin) setSourceOrigin(nextOrigin);
    setBaseline(cloneDraft(draft));
    showToast(readOnlySource ? "Saved copy to Workspace" : "Saved");
    appendSession(readOnlySource ? "Saved copy" : "Saved");
    void runCatalogValidate();
  }, [
    appendSession,
    catalogProjectRoot,
    destination,
    draft,
    readOnlySource,
    runCatalogValidate,
    runDraftValidate,
    stageFilePath,
    stageMode,
  ]);

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
      if (stageMode && yamlPathsMatch(path, stageFilePath)) return;
      const key = normalizeYamlPath(path);
      setOpenPaths((current) => current.filter((open) => normalizeYamlPath(open) !== key));
      setYamlPath((active) =>
        active && normalizeYamlPath(active) === key ? pipelinePath : active,
      );
    },
    [pipelinePath, stageFilePath, stageMode],
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

  const saveDisabled =
    !dirty || saving || loading || !draft || yamlParseError !== null;

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
        when: () =>
          !stageMode && editorTab === "editor" && !!draft && !loading,
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
  const workshopHref = stageMode
    ? ""
    : `#${workshopPath({
        pipeline: pipeline.path,
        ...(catalogProjectRoot ? { project_root: catalogProjectRoot } : {}),
      })}`;

  const copyPath = useCallback(() => {
    const path = stageMode ? stageFilePath : pipeline.path;
    void navigator.clipboard.writeText(path).then(
      () => showToast("Copied path"),
      () => showToast("Could not copy path"),
    );
  }, [pipeline.path, stageFilePath, stageMode]);

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
        mode={mode}
        pipelineId={headerId}
        filePath={headerFilePath}
        unsavedCount={unsavedCount}
        pills={pills}
        discardDisabled={loading || (unsavedCount === 0 && yamlParseError === null)}
        saveDisabled={saveDisabled}
        saving={saving}
        workshopHref={workshopHref}
        readOnlyNotice={editorReadOnlyNotice(readOnlySource)}
        saveLabel={editorSaveLabel(readOnlySource, dirty)}
        onDiscard={onDiscard}
        onStartRun={() =>
          onNew(
            newRunPath({
              pipeline: pipeline.path,
              ...(defaultTask ? { task: defaultTask } : {}),
              ...(catalogProjectRoot ? { project_root: catalogProjectRoot } : {}),
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
      {!stageMode && editorTab === "runs" ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <PipelineEditorRuns runs={pipelineRuns} loading={runsLoading} error={runsError} />
        </div>
      ) : null}
      {!stageMode && editorTab === "history" ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <PipelineEditorHistory events={historyEvents} runs={pipelineRuns} loading={runsLoading} />
        </div>
      ) : null}
      {editorTab === "editor" && loadError ? (
        <p className="px-5 pt-3 text-[13px] text-[var(--sf-fail)]">{loadError}</p>
      ) : null}
      {editorTab === "editor" && loading ? (
        <p className="px-5 py-4 text-[13px] text-[var(--sf-text-3)]">
          {stageMode ? "Loading stage…" : "Loading package…"}
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
              hideAddStage={stageMode}
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
              projectRoot={catalogProjectRoot}
              workshopHref={stageMode ? undefined : workshopHref}
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
              if (stageMode) {
                if (draft) void runDraftValidate(draft);
                return;
              }
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
