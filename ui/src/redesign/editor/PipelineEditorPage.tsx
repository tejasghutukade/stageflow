import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  fetchCatalogValidate,
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
import { StatusPill } from "../StatusPill";
import { FilterTabs } from "../shell/FilterTabs";
import { PageHeader } from "../shell/PageHeader";
import { cloneDraft } from "./draftMutators";
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
  tasks: TaskListing[];
  onNew: (path: string) => void;
};

export function PipelineEditorPage({
  pipelineId,
  pipeline,
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
  const [editorTab, setEditorTab] = useState("editor");
  const [draftValidation, setDraftValidation] =
    useState<DraftValidationResult | null>(null);
  const [catalogFindings, setCatalogFindings] = useState<ValidationFinding[]>(
    [],
  );
  const [validating, setValidating] = useState(false);
  const [validateError, setValidateError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const dirty = useMemo(() => {
    if (!draft || !baseline) return false;
    return JSON.stringify(draft) !== JSON.stringify(baseline);
  }, [baseline, draft]);

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
    if (!draft) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void runDraftValidate(draft);
    }, 400);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [draft, runDraftValidate]);

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

  const defaultTask = defaultTaskForPipeline(pipeline, tasks);
  const pillSignal =
    draftValidation && !draftValidation.ok
      ? "needs"
      : draftValidation && draftValidation.summary.warnings > 0
        ? "queued"
        : "ok";

  return (
    <div className="flex min-h-screen min-w-0 flex-col">
      <PageHeader
        title={pipelineId}
        subtitle={pipeline.path}
        actions={
          <>
            {draftValidation ? (
              <StatusPill
                signal={pillSignal}
                label={
                  draftValidation.ok
                    ? draftValidation.summary.warnings > 0
                      ? "Warnings"
                      : "Valid"
                    : "Invalid"
                }
              />
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
              className="sf-btn sf-btn--ghost"
              href={`#${workshopPath({ pipeline: pipeline.path })}`}
            >
              Open in Workshop
            </a>
            <button
              type="button"
              className="sf-btn sf-btn--ghost"
              onClick={() =>
                onNew(
                  newRunPath({
                    pipeline: pipeline.path,
                    ...(defaultTask ? { task: defaultTask } : {}),
                  }),
                )
              }
            >
              Start run
            </button>
            <button
              type="button"
              className="sf-btn sf-btn--primary"
              disabled={!dirty || saving || !draft}
              onClick={() => void onSave()}
            >
              Save
            </button>
          </>
        }
      />
      <FilterTabs
        variant="underline"
        tabs={[
          { id: "editor", label: "Editor" },
          { id: "runs", label: "Runs", count: 0 },
          { id: "history", label: "History", count: 0 },
        ]}
        activeId={editorTab}
        onChange={setEditorTab}
      />
      {loadError ? (
        <p className="px-5 pt-3 text-[13px] text-[var(--sf-fail)]">{loadError}</p>
      ) : null}
      {loading ? (
        <p className="px-5 py-4 text-[13px] text-[var(--sf-text-3)]">
          Loading package…
        </p>
      ) : null}
      {!loading && draft ? (
        <div className="flex min-h-0 flex-1 flex-col">
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
              listingStages={pipeline.stages}
              selectedStageId={selectedStageId}
              onSelectStage={setSelectedStageId}
            />
            <PipelineEditorInspector
              draft={draft}
              selectedStageId={selectedStageId}
              onDraftChange={onDraftChange}
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
