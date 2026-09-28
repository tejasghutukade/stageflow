import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  attachTaskArtifact,
  checkWorkshopDiskChange,
  clearWorkshopAutosave,
  createDraftPackageWithDetails,
  fetchTasks,
  getWorkshopAutosave,
  openDraftPackage,
  overwriteDraftPackageWithDetails,
  putWorkshopAutosave,
  validateDraftPackage,
  type DraftValidationResult,
  type TaskListing,
  type ValidationFinding,
  type WorkshopAutosavePayload,
} from "../api";
import { PipelineTrack, type TrackStage } from "../components/PipelineTrack";
import {
  navigate,
  newRunPath,
  parseHash,
  pipelinePath,
  workshopPath,
} from "../routes";
import { showToast } from "../toast";
import {
  DIRTY_DISCARD_CONFIRM,
  DIRTY_LEAVE_CONFIRM,
  DIRTY_NEW_CONFIRM,
  workshopAutosaveSlotKey,
  workshopSessionFingerprint,
  type WorkshopAutosaveDestination,
} from "../workshop/autosave";
import {
  autoApplyStatusMessage,
  canOfferRunShortcut,
  draftStageIds,
  emptyDraftPackage,
  formatArtifactDiffLine,
  isProposalStale,
  isTaskProposalIntent,
  parseAutoApplyIntent,
  proposeStageFromMessage,
  proposeTaskFromMessage,
  STALE_PROPOSAL_NOTICE,
  WORKSHOP_AUTHOR_GREETING,
  type ChatMessage,
  type DraftPackage,
  type ProposalArtifactDiff,
  type WorkshopProposal,
} from "../workshop/draft";
import {
  addStageToDraft,
  createTaskInDraft,
  detachTaskFromDraft,
  patchTaskBody,
  removeStageFromDraft,
  setTaskInDraft,
} from "../workshop/draftEdits";
import {
  DraftInspector,
  type InspectorSelection,
} from "../workshop/DraftInspector";

const AUTOSAVE_DEBOUNCE_MS = 500;

let msgSeq = 0;
function nextMsgId(): string {
  msgSeq += 1;
  return `msg-${msgSeq}`;
}

function greetingMessages(): ChatMessage[] {
  return [
    {
      id: nextMsgId(),
      role: "assistant",
      text: WORKSHOP_AUTHOR_GREETING,
    },
  ];
}

function normalizeMessages(
  raw: WorkshopAutosavePayload["messages"],
): ChatMessage[] {
  return raw.map((m) => ({
    id: m.id,
    role: m.role,
    text: m.text,
    ...(Array.isArray(m.artifacts)
      ? { artifacts: m.artifacts as ProposalArtifactDiff[] }
      : {}),
  }));
}

function definitionTrack(
  draft: DraftPackage,
  proposedIds: ReadonlySet<string>,
  selectedId: string | null,
): TrackStage[] {
  return draftStageIds(draft).map((id) => ({
    id,
    label: id,
    status: "pending" as const,
    selected: selectedId === id,
    proposed: proposedIds.has(id),
  }));
}

function ArtifactDiffList({
  artifacts,
}: {
  artifacts: ProposalArtifactDiff[];
}) {
  if (artifacts.length === 0) return null;
  return (
    <ul className="workshop__diff-list" aria-label="Per-artifact diff">
      {artifacts.map((diff) => (
        <li key={`${diff.kind}-${diff.path}`}>
          {formatArtifactDiffLine(diff)}
          {diff.after || diff.before ? (
            <pre>{diff.after ?? diff.before}</pre>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

type Destination = WorkshopAutosaveDestination;

type DiskChangeBanner = {
  changedPaths: string[];
  currentFingerprints: Record<string, string>;
};

function openedPackageMessages(
  pipelinePathValue: string,
  draft: DraftPackage,
): ChatMessage[] {
  const taskNote = draft.task
    ? ` Task “${draft.task.filename}” is attached.`
    : " Task panel stays empty until you attach a task.";
  return [
    {
      id: nextMsgId(),
      role: "assistant",
      text: `Opened ${pipelinePathValue}. Edit the DAG or inspector — Save overwrites the known package paths.${taskNote}`,
    },
  ];
}

export function WorkshopPage({
  openPipelinePath,
  openTaskPath,
}: {
  openPipelinePath?: string;
  openTaskPath?: string;
}) {
  const [draft, setDraft] = useState<DraftPackage>(() => emptyDraftPackage());
  const [messages, setMessages] = useState<ChatMessage[]>(() =>
    greetingMessages(),
  );
  const [pending, setPending] = useState<WorkshopProposal | null>(null);
  const [autoApply, setAutoApply] = useState(false);
  const [sessionModelOverride, setSessionModelOverride] = useState<
    string | null
  >(null);
  const [input, setInput] = useState("");
  const [findings, setFindings] = useState<ValidationFinding[]>([]);
  const [validationOk, setValidationOk] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const [savedTaskPath, setSavedTaskPath] = useState<string | null>(null);
  const [destination, setDestination] = useState<Destination | null>(null);
  const [showSaveForm, setShowSaveForm] = useState(false);
  const [saveDirectory, setSaveDirectory] = useState("pipelines");
  const [savePipelineId, setSavePipelineId] = useState("untitled");
  const [selection, setSelection] = useState<InspectorSelection | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const [taskMode, setTaskMode] = useState<"idle" | "create" | "attach">(
    "idle",
  );
  const [taskIdDraft, setTaskIdDraft] = useState("task");
  const [taskGoalDraft, setTaskGoalDraft] = useState("");
  const [taskListings, setTaskListings] = useState<TaskListing[]>([]);
  const [attachPath, setAttachPath] = useState("");
  const [diskFingerprints, setDiskFingerprints] = useState<
    Record<string, string>
  >({});
  const [diskChange, setDiskChange] = useState<DiskChangeBanner | null>(null);
  const [cleanBaseline, setCleanBaseline] = useState(() =>
    workshopSessionFingerprint({
      draft: emptyDraftPackage(),
      messages: [],
      autoApply: false,
      sessionModelOverride: null,
    }),
  );
  const [hydrated, setHydrated] = useState(false);

  const autosaveKey = workshopAutosaveSlotKey(
    openPipelinePath ?? savedPath ?? null,
  );
  const sessionFingerprint = workshopSessionFingerprint({
    draft,
    messages,
    autoApply,
    sessionModelOverride,
  });
  const dirty = hydrated && sessionFingerprint !== cleanBaseline;

  const dirtyRef = useRef(dirty);
  const suppressHashRef = useRef(false);
  const persistPayloadRef = useRef<{
    key: string;
    draft: DraftPackage;
    messages: ChatMessage[];
    autoApply: boolean;
    sessionModelOverride: string | null;
    destination: Destination | null;
    savedPath: string | null;
    savedTaskPath: string | null;
    diskFingerprints: Record<string, string>;
  } | null>(null);
  const openPipelinePathRef = useRef(openPipelinePath);
  const openTaskPathRef = useRef(openTaskPath);

  dirtyRef.current = dirty;
  openPipelinePathRef.current = openPipelinePath;
  openTaskPathRef.current = openTaskPath;
  persistPayloadRef.current = {
    key: autosaveKey,
    draft,
    messages,
    autoApply,
    sessionModelOverride,
    destination,
    savedPath,
    savedTaskPath,
    diskFingerprints,
  };

  const proposedIds = useMemo(() => {
    if (!pending) return new Set<string>();
    return new Set(pending.affectedStageIds);
  }, [pending]);

  const selectedStageId =
    selection?.kind === "stage" ? selection.stageId : null;

  const track = useMemo(
    () =>
      definitionTrack(
        pending ? pending.nextDraft : draft,
        proposedIds,
        selectedStageId,
      ),
    [draft, pending, proposedIds, selectedStageId],
  );
  const canSave = validationOk === true && !busy;
  const showRunShortcut = canOfferRunShortcut({
    savedPipelinePath: savedPath,
    savedTaskPath,
    hasTaskInDraft: Boolean(draft.task),
  });

  const persistAutosave = useCallback(async () => {
    const payload = persistPayloadRef.current;
    if (!payload) return;
    await putWorkshopAutosave({
      version: 1,
      key: payload.key,
      updatedAt: new Date().toISOString(),
      draft: payload.draft,
      messages: payload.messages,
      autoApply: payload.autoApply,
      sessionModelOverride: payload.sessionModelOverride,
      destination: payload.destination,
      savedPath: payload.savedPath,
      savedTaskPath: payload.savedTaskPath,
      diskFingerprints: payload.diskFingerprints,
    });
  }, []);

  const markClean = useCallback(
    (next: {
      draft: DraftPackage;
      messages: ChatMessage[];
      autoApply: boolean;
      sessionModelOverride: string | null;
    }) => {
      setCleanBaseline(workshopSessionFingerprint(next));
    },
    [],
  );

  const resetTransientUi = useCallback(() => {
    setPending(null);
    setFindings([]);
    setValidationOk(null);
    setShowSaveForm(false);
    setOpenError(null);
    setTaskMode("idle");
    setInput("");
  }, []);

  const applyOpenedPackage = useCallback(
    (input: {
      draft: DraftPackage;
      destination: Destination;
      pipelinePath: string;
      taskPath: string | null;
      fingerprints: Record<string, string>;
      messages: ChatMessage[];
      autoApply?: boolean;
      sessionModelOverride?: string | null;
    }) => {
      const nextAutoApply = input.autoApply ?? false;
      const nextOverride = input.sessionModelOverride ?? null;
      setDraft(input.draft);
      setDestination(input.destination);
      setSavedPath(input.pipelinePath);
      setSavedTaskPath(input.taskPath);
      setSavePipelineId(input.draft.pipeline.id);
      setSaveDirectory(input.destination.directory);
      setMessages(input.messages);
      setAutoApply(nextAutoApply);
      setSessionModelOverride(nextOverride);
      setDiskFingerprints(input.fingerprints);
      setDiskChange(null);
      setSelection({ kind: "pipeline" });
      resetTransientUi();
      markClean({
        draft: input.draft,
        messages: input.messages,
        autoApply: nextAutoApply,
        sessionModelOverride: nextOverride,
      });
    },
    [markClean, resetTransientUi],
  );

  const loadPackageFromDisk = useCallback(
    async (
      pipeline: string,
      task?: string | null,
      baseline?: Record<string, string> | null,
    ) => {
      const result = await openDraftPackage({
        path: pipeline,
        ...(task ? { task } : {}),
      });
      if (!result.ok) {
        return { ok: false as const, error: result.error };
      }
      const fp = await checkWorkshopDiskChange({
        pipelinePath: result.pipelinePath,
        draft: result.draft,
        taskPath: result.taskPath ?? null,
        baseline: baseline ?? null,
      });
      const fingerprints = fp.ok ? fp.fingerprints : {};
      return {
        ok: true as const,
        draft: result.draft,
        destination: result.destination,
        pipelinePath: result.pipelinePath,
        taskPath: result.taskPath ?? null,
        fingerprints,
        changed: fp.ok ? fp.changed : false,
        changedPaths: fp.ok ? fp.changedPaths : [],
      };
    },
    [],
  );

  const discardPendingForEdit = useCallback(
    (notice = STALE_PROPOSAL_NOTICE) => {
      if (!pending) return;
      setPending(null);
      setMessages((prev) => [
        ...prev,
        {
          id: nextMsgId(),
          role: "system",
          text: notice,
        },
      ]);
    },
    [pending],
  );

  const applyDraft = useCallback(
    (next: DraftPackage) => {
      if (pending) {
        discardPendingForEdit();
      }
      setDraft(next);
      setValidationOk(null);
      setSavedTaskPath(null);
    },
    [discardPendingForEdit, pending],
  );

  const resetToEmptyNew = useCallback(() => {
    const nextDraft = emptyDraftPackage();
    const nextMessages = greetingMessages();
    setDraft(nextDraft);
    setMessages(nextMessages);
    setPending(null);
    setAutoApply(false);
    setSessionModelOverride(null);
    setFindings([]);
    setValidationOk(null);
    setSavedPath(null);
    setSavedTaskPath(null);
    setDestination(null);
    setShowSaveForm(false);
    setSavePipelineId("untitled");
    setSelection(null);
    setOpenError(null);
    setTaskMode("idle");
    setInput("");
    setDiskFingerprints({});
    setDiskChange(null);
    markClean({
      draft: nextDraft,
      messages: nextMessages,
      autoApply: false,
      sessionModelOverride: null,
    });
  }, [markClean]);

  const startNew = useCallback(() => {
    if (dirty && !window.confirm(DIRTY_NEW_CONFIRM)) return;
    const key = autosaveKey;
    void clearWorkshopAutosave({ key });
    dirtyRef.current = false;
    resetToEmptyNew();
    if (openPipelinePath || openTaskPath) {
      suppressHashRef.current = true;
      navigate(workshopPath());
    }
  }, [
    autosaveKey,
    dirty,
    openPipelinePath,
    openTaskPath,
    resetToEmptyNew,
  ]);

  const onDiscard = useCallback(() => {
    if (dirty && !window.confirm(DIRTY_DISCARD_CONFIRM)) return;
    dirtyRef.current = false;
    const key = autosaveKey;
    const reloadPath = openPipelinePath ?? savedPath;
    const reloadTask = openTaskPath ?? savedTaskPath;
    void (async () => {
      setBusy(true);
      try {
        await clearWorkshopAutosave({ key });
        if (reloadPath) {
          const loaded = await loadPackageFromDisk(reloadPath, reloadTask);
          if (!loaded.ok) {
            setOpenError(loaded.error);
            showToast(loaded.error);
            resetToEmptyNew();
            return;
          }
          applyOpenedPackage({
            draft: loaded.draft,
            destination: loaded.destination,
            pipelinePath: loaded.pipelinePath,
            taskPath: loaded.taskPath,
            fingerprints: loaded.fingerprints,
            messages: openedPackageMessages(
              loaded.pipelinePath,
              loaded.draft,
            ),
          });
        } else {
          resetToEmptyNew();
        }
      } finally {
        setBusy(false);
      }
    })();
  }, [
    applyOpenedPackage,
    autosaveKey,
    dirty,
    loadPackageFromDisk,
    openPipelinePath,
    openTaskPath,
    resetToEmptyNew,
    savedPath,
    savedTaskPath,
  ]);

  const onReloadDisk = useCallback(() => {
    const reloadPath = openPipelinePath ?? savedPath;
    if (!reloadPath) {
      setDiskChange(null);
      return;
    }
    dirtyRef.current = false;
    const key = autosaveKey;
    const reloadTask = openTaskPath ?? savedTaskPath;
    void (async () => {
      setBusy(true);
      try {
        await clearWorkshopAutosave({ key });
        const loaded = await loadPackageFromDisk(reloadPath, reloadTask);
        if (!loaded.ok) {
          setOpenError(loaded.error);
          showToast(loaded.error);
          return;
        }
        applyOpenedPackage({
          draft: loaded.draft,
          destination: loaded.destination,
          pipelinePath: loaded.pipelinePath,
          taskPath: loaded.taskPath,
          fingerprints: loaded.fingerprints,
          messages: openedPackageMessages(loaded.pipelinePath, loaded.draft),
        });
      } finally {
        setBusy(false);
      }
    })();
  }, [
    applyOpenedPackage,
    autosaveKey,
    loadPackageFromDisk,
    openPipelinePath,
    openTaskPath,
    savedPath,
    savedTaskPath,
  ]);

  const onKeepDiskDraft = useCallback(() => {
    if (!diskChange) return;
    const nextFingerprints = diskChange.currentFingerprints;
    setDiskFingerprints(nextFingerprints);
    setDiskChange(null);
    void putWorkshopAutosave({
      version: 1,
      key: autosaveKey,
      updatedAt: new Date().toISOString(),
      draft,
      messages,
      autoApply,
      sessionModelOverride,
      destination,
      savedPath,
      savedTaskPath,
      diskFingerprints: nextFingerprints,
    });
  }, [
    autosaveKey,
    autoApply,
    destination,
    diskChange,
    draft,
    messages,
    savedPath,
    savedTaskPath,
    sessionModelOverride,
  ]);

  useEffect(() => {
    let cancelled = false;
    setHydrated(false);
    setBusy(true);
    setOpenError(null);
    setDiskChange(null);
    setPending(null);

    void (async () => {
      const key = workshopAutosaveSlotKey(openPipelinePath ?? null);
      const autosaveResult = await getWorkshopAutosave({ key });
      if (cancelled) return;
      const autosave = autosaveResult.ok ? autosaveResult.autosave : null;

      if (openPipelinePath) {
        const loaded = await loadPackageFromDisk(
          openPipelinePath,
          openTaskPath,
          autosave?.diskFingerprints ?? null,
        );
        if (cancelled) return;
        if (!loaded.ok) {
          setOpenError(loaded.error);
          showToast(loaded.error);
          setBusy(false);
          setHydrated(true);
          return;
        }

        if (autosave) {
          const restoredMessages = normalizeMessages(autosave.messages);
          const restoredAutoApply = autosave.autoApply;
          const restoredOverride = autosave.sessionModelOverride ?? null;
          const restoredDraft = autosave.draft as DraftPackage;
          setDraft(restoredDraft);
          setMessages(restoredMessages);
          setAutoApply(restoredAutoApply);
          setSessionModelOverride(restoredOverride);
          setDestination(
            (autosave.destination as Destination | null | undefined) ??
              loaded.destination,
          );
          setSavedPath(autosave.savedPath ?? loaded.pipelinePath);
          setSavedTaskPath(autosave.savedTaskPath ?? loaded.taskPath);
          setSavePipelineId(restoredDraft.pipeline.id);
          setSaveDirectory(
            (
              (autosave.destination as Destination | null | undefined) ??
              loaded.destination
            ).directory,
          );
          setDiskFingerprints(
            autosave.diskFingerprints ?? loaded.fingerprints,
          );
          setSelection({ kind: "pipeline" });
          resetTransientUi();
          markClean({
            draft: restoredDraft,
            messages: restoredMessages,
            autoApply: restoredAutoApply,
            sessionModelOverride: restoredOverride,
          });
          if (loaded.changed) {
            setDiskChange({
              changedPaths: loaded.changedPaths,
              currentFingerprints: loaded.fingerprints,
            });
          }
        } else {
          applyOpenedPackage({
            draft: loaded.draft,
            destination: loaded.destination,
            pipelinePath: loaded.pipelinePath,
            taskPath: loaded.taskPath,
            fingerprints: loaded.fingerprints,
            messages: openedPackageMessages(
              loaded.pipelinePath,
              loaded.draft,
            ),
          });
        }
        setBusy(false);
        setHydrated(true);
        return;
      }

      if (autosave) {
        const restoredMessages = normalizeMessages(autosave.messages);
        const restoredDraft = autosave.draft as DraftPackage;
        const restoredAutoApply = autosave.autoApply;
        const restoredOverride = autosave.sessionModelOverride ?? null;
        setDraft(restoredDraft);
        setMessages(restoredMessages);
        setAutoApply(restoredAutoApply);
        setSessionModelOverride(restoredOverride);
        setDestination(
          (autosave.destination as Destination | null | undefined) ?? null,
        );
        setSavedPath(autosave.savedPath ?? null);
        setSavedTaskPath(autosave.savedTaskPath ?? null);
        setSavePipelineId(restoredDraft.pipeline.id || "untitled");
        if (autosave.destination && typeof autosave.destination === "object") {
          setSaveDirectory(
            (autosave.destination as Destination).directory || "pipelines",
          );
        }
        setDiskFingerprints(autosave.diskFingerprints ?? {});
        setSelection({ kind: "pipeline" });
        resetTransientUi();
        markClean({
          draft: restoredDraft,
          messages: restoredMessages,
          autoApply: restoredAutoApply,
          sessionModelOverride: restoredOverride,
        });
        if (autosave.savedPath) {
          const fp = await checkWorkshopDiskChange({
            pipelinePath: autosave.savedPath,
            draft: restoredDraft,
            taskPath: autosave.savedTaskPath ?? null,
            baseline: autosave.diskFingerprints ?? null,
          });
          if (!cancelled && fp.ok && fp.changed) {
            setDiskChange({
              changedPaths: fp.changedPaths,
              currentFingerprints: fp.fingerprints,
            });
          }
        }
      } else {
        resetToEmptyNew();
      }
      if (!cancelled) {
        setBusy(false);
        setHydrated(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    applyOpenedPackage,
    loadPackageFromDisk,
    markClean,
    openPipelinePath,
    openTaskPath,
    resetToEmptyNew,
    resetTransientUi,
  ]);

  useEffect(() => {
    if (!hydrated || !dirty) return;
    const timer = window.setTimeout(() => {
      void persistAutosave();
    }, AUTOSAVE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [
    hydrated,
    dirty,
    draft,
    messages,
    autoApply,
    sessionModelOverride,
    destination,
    savedPath,
    savedTaskPath,
    diskFingerprints,
    autosaveKey,
    persistAutosave,
  ]);

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirtyRef.current) return;
      void persistAutosave();
      event.preventDefault();
      event.returnValue = "";
    };

    const onHashChange = () => {
      if (suppressHashRef.current) {
        suppressHashRef.current = false;
        return;
      }
      if (!dirtyRef.current) return;
      const route = parseHash();
      const staying =
        route.name === "workshop" &&
        (route.pipelinePath ?? undefined) ===
          (openPipelinePathRef.current ?? undefined) &&
        (route.taskPath ?? undefined) === (openTaskPathRef.current ?? undefined);
      if (staying) return;
      if (!window.confirm(DIRTY_LEAVE_CONFIRM)) {
        suppressHashRef.current = true;
        navigate(
          workshopPath({
            ...(openPipelinePathRef.current
              ? { pipeline: openPipelinePathRef.current }
              : {}),
            ...(openTaskPathRef.current
              ? { task: openTaskPathRef.current }
              : {}),
          }),
        );
        return;
      }
      void persistAutosave();
    };

    window.addEventListener("beforeunload", onBeforeUnload);
    window.addEventListener("hashchange", onHashChange);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      window.removeEventListener("hashchange", onHashChange);
    };
  }, [persistAutosave]);

  const clearAutosaveAfterSave = useCallback(
    async (pipelinePathValue: string, nextDraft: DraftPackage, taskPathValue: string | null) => {
      await clearWorkshopAutosave({ key: autosaveKey });
      if (autosaveKey === workshopAutosaveSlotKey(null)) {
        await clearWorkshopAutosave({
          key: workshopAutosaveSlotKey(pipelinePathValue),
        });
      }
      const fp = await checkWorkshopDiskChange({
        pipelinePath: pipelinePathValue,
        draft: nextDraft,
        taskPath: taskPathValue,
        baseline: null,
      });
      const fingerprints = fp.ok ? fp.fingerprints : {};
      setDiskFingerprints(fingerprints);
      setDiskChange(null);
      return fingerprints;
    },
    [autosaveKey],
  );

  const onSend = useCallback(() => {
    const text = input.trim();
    if (!text || busy || pending) return;
    setInput("");
    setMessages((prev) => [
      ...prev,
      { id: nextMsgId(), role: "user", text },
    ]);

    const intent = parseAutoApplyIntent(text);
    if (intent !== null) {
      setAutoApply(intent);
      setMessages((prev) => [
        ...prev,
        {
          id: nextMsgId(),
          role: "system",
          text: autoApplyStatusMessage(intent),
        },
      ]);
      return;
    }

    const proposal = isTaskProposalIntent(text)
      ? proposeTaskFromMessage(draft, text)
      : proposeStageFromMessage(draft, text);
    if (autoApply) {
      setDraft(proposal.nextDraft);
      setSavedTaskPath(null);
      if (typeof proposal.nextDraft.pipeline.id === "string") {
        setSavePipelineId(proposal.nextDraft.pipeline.id);
      }
      setValidationOk(null);
      setMessages((prev) => [
        ...prev,
        {
          id: nextMsgId(),
          role: "assistant",
          text: `Applied to draft: ${proposal.summary}. Nothing was written to disk — Save when you are ready.`,
          artifacts: proposal.artifacts,
        },
      ]);
      return;
    }

    setPending(proposal);
    setMessages((prev) => [
      ...prev,
      {
        id: nextMsgId(),
        role: "assistant",
        text: `I propose: ${proposal.summary}. Review the per-artifact diff and Accept to update the draft, or Reject to leave it unchanged.`,
        artifacts: proposal.artifacts,
      },
    ]);
  }, [autoApply, busy, draft, input, pending]);

  const onAccept = useCallback(() => {
    if (!pending) return;
    if (isProposalStale(pending, draft)) {
      setPending(null);
      setMessages((prev) => [
        ...prev,
        {
          id: nextMsgId(),
          role: "system",
          text: STALE_PROPOSAL_NOTICE,
        },
      ]);
      return;
    }
    setDraft(pending.nextDraft);
    setSavedTaskPath(null);
    if (typeof pending.nextDraft.pipeline.id === "string") {
      setSavePipelineId(pending.nextDraft.pipeline.id);
    }
    setPending(null);
    setValidationOk(null);
    setMessages((prev) => [
      ...prev,
      {
        id: nextMsgId(),
        role: "system",
        text: `Accepted: ${pending.summary}`,
      },
    ]);
  }, [draft, pending]);

  const onReject = useCallback(() => {
    if (!pending) return;
    const summary = pending.summary;
    setPending(null);
    setMessages((prev) => [
      ...prev,
      {
        id: nextMsgId(),
        role: "system",
        text: `Rejected: ${summary}`,
      },
    ]);
  }, [pending]);

  const onValidate = useCallback(async () => {
    setBusy(true);
    try {
      const result: DraftValidationResult = await validateDraftPackage(draft);
      setFindings(result.findings);
      setValidationOk(result.ok);
      if (result.ok) {
        showToast("Draft is valid");
      } else {
        showToast(
          `${result.summary.errors} validation error${result.summary.errors === 1 ? "" : "s"}`,
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setValidationOk(false);
      setFindings([
        {
          severity: "error",
          code: "workshop.validate_failed",
          path: "<draft>",
          message,
          category: "pipeline",
        },
      ]);
      showToast(message);
    } finally {
      setBusy(false);
    }
  }, [draft]);

  const onSaveClick = useCallback(async () => {
    if (validationOk !== true) {
      showToast("Validate successfully before Save");
      return;
    }
    if (destination) {
      setBusy(true);
      try {
        const result = await overwriteDraftPackageWithDetails({
          directory: destination.directory,
          draft,
          ...(destination.pipelineFilename
            ? { pipelineFilename: destination.pipelineFilename }
            : {}),
        });
        if (!result.ok) {
          if (result.findings) setFindings(result.findings);
          setValidationOk(false);
          showToast(result.error);
          return;
        }
        setSavedPath(result.pipelinePath);
        setSavedTaskPath(result.taskPath ?? null);
        await clearAutosaveAfterSave(
          result.pipelinePath,
          draft,
          result.taskPath ?? null,
        );
        markClean({
          draft,
          messages,
          autoApply,
          sessionModelOverride,
        });
        dirtyRef.current = false;
        showToast(`Saved ${result.pipelinePath}`);
      } finally {
        setBusy(false);
      }
      return;
    }
    setShowSaveForm(true);
    setSavePipelineId(draft.pipeline.id || "untitled");
  }, [
    autoApply,
    clearAutosaveAfterSave,
    destination,
    draft,
    markClean,
    messages,
    sessionModelOverride,
    validationOk,
  ]);

  const onConfirmSave = useCallback(async () => {
    if (validationOk !== true) {
      showToast("Save blocked: draft is invalid");
      return;
    }
    const directory = saveDirectory.trim() || "pipelines";
    const id = savePipelineId.trim() || "untitled";
    const packageDraft: DraftPackage = {
      ...draft,
      pipeline: { ...draft.pipeline, id },
    };
    setBusy(true);
    try {
      const result = await createDraftPackageWithDetails({
        directory,
        draft: packageDraft,
      });
      if (!result.ok) {
        if (result.findings) setFindings(result.findings);
        setValidationOk(false);
        showToast(result.error);
        return;
      }
      setDraft(packageDraft);
      setSavedPath(result.pipelinePath);
      setSavedTaskPath(result.taskPath ?? null);
      setDestination({
        directory,
        pipelineFilename: `${id}.pipeline.yaml`,
      });
      setShowSaveForm(false);
      await clearAutosaveAfterSave(
        result.pipelinePath,
        packageDraft,
        result.taskPath ?? null,
      );
      markClean({
        draft: packageDraft,
        messages,
        autoApply,
        sessionModelOverride,
      });
      dirtyRef.current = false;
      showToast(`Saved ${result.pipelinePath}`);
    } finally {
      setBusy(false);
    }
  }, [
    autoApply,
    clearAutosaveAfterSave,
    draft,
    markClean,
    messages,
    saveDirectory,
    savePipelineId,
    sessionModelOverride,
    validationOk,
  ]);

  const onAddStage = useCallback(() => {
    const next = addStageToDraft(draft, `stage-${draft.pipeline.stages.length + 1}`);
    applyDraft(next);
    const ids = draftStageIds(next);
    const added = ids[ids.length - 1];
    if (added) setSelection({ kind: "stage", stageId: added });
  }, [applyDraft, draft]);

  const onRemoveStage = useCallback(
    (stageId: string) => {
      applyDraft(removeStageFromDraft(draft, stageId));
      setSelection({ kind: "pipeline" });
    },
    [applyDraft, draft],
  );

  const onAutoApplyToggle = useCallback(
    (enabled: boolean) => {
      setAutoApply(enabled);
      setMessages((prev) => [
        ...prev,
        {
          id: nextMsgId(),
          role: "system",
          text: autoApplyStatusMessage(enabled),
        },
      ]);
    },
    [],
  );

  const beginCreateTask = useCallback(() => {
    setTaskMode("create");
    setTaskIdDraft(
      typeof draft.task?.body.id === "string" && draft.task.body.id
        ? draft.task.body.id
        : draft.pipeline.id || "task",
    );
    setTaskGoalDraft(
      typeof draft.task?.body.goal === "string" ? draft.task.body.goal : "",
    );
  }, [draft]);

  const beginAttachTask = useCallback(() => {
    setTaskMode("attach");
    setBusy(true);
    void (async () => {
      try {
        const result = await fetchTasks();
        setTaskListings(result.tasks);
        setAttachPath(result.tasks[0]?.path ?? "");
      } catch (err) {
        showToast(err instanceof Error ? err.message : String(err));
        setTaskMode("idle");
      } finally {
        setBusy(false);
      }
    })();
  }, []);

  const onConfirmCreateTask = useCallback(() => {
    applyDraft(
      createTaskInDraft(draft, {
        id: taskIdDraft.trim() || "task",
        goal: taskGoalDraft.trim() || "Describe the workflow goal",
      }),
    );
    setTaskMode("idle");
    setSavedTaskPath(null);
  }, [applyDraft, draft, taskGoalDraft, taskIdDraft]);

  const onConfirmAttachTask = useCallback(async () => {
    if (!attachPath.trim()) {
      showToast("Pick a task to attach");
      return;
    }
    setBusy(true);
    try {
      const result = await attachTaskArtifact({ task: attachPath.trim() });
      if (!result.ok) {
        showToast(result.error);
        return;
      }
      applyDraft(setTaskInDraft(draft, result.task));
      setTaskMode("idle");
      setSavedTaskPath(null);
      showToast(`Attached ${result.taskPath}`);
    } finally {
      setBusy(false);
    }
  }, [applyDraft, attachPath, draft]);

  const onDetachTask = useCallback(() => {
    applyDraft(detachTaskFromDraft(draft));
    setTaskMode("idle");
  }, [applyDraft, draft]);

  const onRunWorkflow = useCallback(() => {
    if (!savedPath || !savedTaskPath) return;
    navigate(newRunPath({ pipeline: savedPath, task: savedTaskPath }));
  }, [savedPath, savedTaskPath]);

  const viewDraft = pending ? pending.nextDraft : draft;
  const subtitlePath = savedPath ? savedPath : "Untitled draft · Workshop Author";

  return (
    <div className="pane workshop">
      <div className="topbar">
        <div className="topbar__title">Workshop</div>
        <div className="topbar__sub">
          {subtitlePath}
          {dirty ? " · unsaved" : ""}
        </div>
        <div className="topbar__spacer" />
        <label className="workshop__auto-apply">
          <input
            type="checkbox"
            checked={autoApply}
            onChange={(e) => onAutoApplyToggle(e.target.checked)}
            disabled={busy}
          />
          Auto-apply chat edits
        </label>
        {showRunShortcut ? (
          <button
            type="button"
            className="btn btn--primary"
            onClick={onRunWorkflow}
            disabled={busy}
          >
            Run this workflow
          </button>
        ) : null}
        {savedPath ? (
          <a className="btn" href={`#${pipelinePath(draft.pipeline.id)}`}>
            Open in catalog
          </a>
        ) : null}
        <button type="button" className="btn" onClick={startNew} disabled={busy}>
          New
        </button>
        <button
          type="button"
          className="btn"
          onClick={onDiscard}
          disabled={busy}
        >
          Discard
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => void onValidate()}
          disabled={busy}
        >
          Validate
        </button>
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => void onSaveClick()}
          disabled={!canSave}
          title={
            validationOk === true
              ? destination
                ? "Overwrite known package paths"
                : "Save package to disk"
              : "Validate successfully before Save"
          }
        >
          Save
        </button>
      </div>

      {diskChange ? (
        <div className="workshop__banner" role="status">
          <p>
            Catalog files changed on disk
            {diskChange.changedPaths.length > 0
              ? ` (${diskChange.changedPaths.join(", ")})`
              : ""}
            . Reload from disk or keep this Workshop draft.
          </p>
          <div className="workshop__proposal-actions">
            <button
              type="button"
              className="btn btn--primary"
              onClick={onReloadDisk}
              disabled={busy}
            >
              Reload
            </button>
            <button
              type="button"
              className="btn"
              onClick={onKeepDiskDraft}
              disabled={busy}
            >
              Keep workshop draft
            </button>
          </div>
        </div>
      ) : null}

      <div className="workshop__body">
        <section className="workshop__canvas" aria-label="Draft DAG">
          <div className="workshop__canvas-head">
            <div className="eyebrow">Draft DAG</div>
            <div className="workshop__canvas-actions">
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => setSelection({ kind: "pipeline" })}
              >
                Pipeline
              </button>
              <button
                type="button"
                className="btn btn--sm"
                onClick={onAddStage}
                disabled={busy}
              >
                Add stage
              </button>
            </div>
          </div>
          {openError ? (
            <p style={{ color: "var(--color-text-red)" }}>{openError}</p>
          ) : null}
          {track.length === 0 ? (
            <p className="empty-hint">
              Empty scaffold — chat with Workshop Author to propose stages, or
              Add stage.
            </p>
          ) : (
            <PipelineTrack
              stages={track}
              mode="definition"
              onSelect={(stageId) =>
                setSelection({ kind: "stage", stageId })
              }
            />
          )}
          <div className="workshop__task-panel">
            <div className="workshop__canvas-head">
              <div className="eyebrow">Task</div>
              <div className="workshop__canvas-actions">
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={beginCreateTask}
                  disabled={busy || Boolean(pending)}
                >
                  {draft.task ? "Edit" : "Create"}
                </button>
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={beginAttachTask}
                  disabled={busy || Boolean(pending)}
                >
                  Attach
                </button>
                {draft.task ? (
                  <button
                    type="button"
                    className="btn btn--sm"
                    onClick={onDetachTask}
                    disabled={busy || Boolean(pending)}
                  >
                    Detach
                  </button>
                ) : null}
              </div>
            </div>
            {taskMode === "create" ? (
              <div className="workshop__task-form">
                <label className="workshop__field">
                  Task id
                  <input
                    className="input"
                    value={taskIdDraft}
                    onChange={(e) => setTaskIdDraft(e.target.value)}
                  />
                </label>
                <label className="workshop__field">
                  Goal
                  <textarea
                    className="input"
                    rows={3}
                    value={taskGoalDraft}
                    onChange={(e) => setTaskGoalDraft(e.target.value)}
                  />
                </label>
                <div className="workshop__proposal-actions">
                  <button
                    type="button"
                    className="btn btn--primary"
                    onClick={onConfirmCreateTask}
                  >
                    Apply to draft
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => setTaskMode("idle")}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : null}
            {taskMode === "attach" ? (
              <div className="workshop__task-form">
                {taskListings.length === 0 ? (
                  <p className="empty-hint">No catalog tasks found.</p>
                ) : (
                  <label className="workshop__field">
                    Existing task
                    <select
                      className="input"
                      value={attachPath}
                      onChange={(e) => setAttachPath(e.target.value)}
                    >
                      {taskListings.map((t) => (
                        <option key={t.path} value={t.path}>
                          {t.id} · {t.path}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <div className="workshop__proposal-actions">
                  <button
                    type="button"
                    className="btn btn--primary"
                    disabled={busy || taskListings.length === 0}
                    onClick={() => void onConfirmAttachTask()}
                  >
                    Attach to draft
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => setTaskMode("idle")}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : null}
            {taskMode === "idle" && viewDraft.task ? (
              <div className="workshop__task-fields">
                <p className="mono">{viewDraft.task.filename}</p>
                <label className="workshop__field">
                  Id
                  <input
                    className="input"
                    value={
                      typeof viewDraft.task.body.id === "string"
                        ? viewDraft.task.body.id
                        : ""
                    }
                    onChange={(e) =>
                      applyDraft(patchTaskBody(draft, { id: e.target.value }))
                    }
                    disabled={Boolean(pending)}
                  />
                </label>
                <label className="workshop__field">
                  Goal
                  <textarea
                    className="input"
                    rows={3}
                    value={
                      typeof viewDraft.task.body.goal === "string"
                        ? viewDraft.task.body.goal
                        : ""
                    }
                    onChange={(e) =>
                      applyDraft(patchTaskBody(draft, { goal: e.target.value }))
                    }
                    disabled={Boolean(pending)}
                  />
                </label>
              </div>
            ) : null}
            {taskMode === "idle" && !viewDraft.task ? (
              <p className="empty-hint">
                Empty — attach an existing task or create one. Pipeline-only
                drafts stay valid without a task.
              </p>
            ) : null}
          </div>
          <DraftInspector
            draft={viewDraft}
            selection={selection}
            onChange={(next) => {
              applyDraft(next);
            }}
            onRemoveStage={onRemoveStage}
          />
          {pending ? (
            <div className="workshop__proposal">
              <div className="eyebrow">Pending proposal</div>
              <p>{pending.summary}</p>
              <ArtifactDiffList artifacts={pending.artifacts} />
              <div className="workshop__proposal-actions">
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={onAccept}
                >
                  Accept
                </button>
                <button type="button" className="btn" onClick={onReject}>
                  Reject
                </button>
              </div>
            </div>
          ) : null}
          {findings.length > 0 ? (
            <div className="workshop__findings" aria-label="Validation findings">
              <div className="eyebrow">
                Validation {validationOk ? "passed" : "findings"}
              </div>
              <ul className="workshop__findings-list">
                {findings.map((f, i) => (
                  <li key={`${f.code}-${f.path}-${i}`}>
                    <span className="mono">{f.severity}</span> · {f.message}
                    <span className="muted"> ({f.path})</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {showSaveForm ? (
            <div className="workshop__save">
              <div className="eyebrow">First Save destination</div>
              <label className="workshop__field">
                Directory
                <input
                  className="input"
                  value={saveDirectory}
                  onChange={(e) => setSaveDirectory(e.target.value)}
                />
              </label>
              <label className="workshop__field">
                Pipeline id
                <input
                  className="input"
                  value={savePipelineId}
                  onChange={(e) => setSavePipelineId(e.target.value)}
                />
              </label>
              <div className="workshop__proposal-actions">
                <button
                  type="button"
                  className="btn btn--primary"
                  disabled={busy}
                  onClick={() => void onConfirmSave()}
                >
                  Create package
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => setShowSaveForm(false)}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : null}
        </section>

        <section className="workshop__chat" aria-label="Workshop Author chat">
          <div className="eyebrow">Workshop Author</div>
          <div className="workshop__transcript">
            {messages.map((m) => (
              <div
                key={m.id}
                className="workshop__bubble"
                data-role={m.role}
              >
                <div className="eyebrow">{m.role}</div>
                <p>{m.text}</p>
                {m.artifacts ? (
                  <ArtifactDiffList artifacts={m.artifacts} />
                ) : null}
              </div>
            ))}
          </div>
          <form
            className="workshop__composer"
            onSubmit={(e) => {
              e.preventDefault();
              onSend();
            }}
          >
            <input
              className="input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={
                pending
                  ? "Accept or Reject the pending proposal first"
                  : "Describe a stage, task, or workflow…"
              }
              disabled={busy || Boolean(pending)}
            />
            <button
              type="submit"
              className="btn btn--primary"
              disabled={busy || Boolean(pending) || !input.trim()}
            >
              Send
            </button>
          </form>
        </section>
      </div>
    </div>
  );
}
