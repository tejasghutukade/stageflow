export type DraftStageArtifact = {
  path: string;
  body: Record<string, unknown>;
};

export type DraftPackage = {
  pipeline: {
    id: string;
    stages: Array<Record<string, unknown>>;
    agent?: unknown;
    model?: unknown;
    schemas?: unknown;
    requires?: unknown;
  };
  stages?: DraftStageArtifact[];
  task?: {
    filename: string;
    body: Record<string, unknown>;
  };
};

export type ProposalArtifactDiff = {
  path: string;
  kind: "added" | "removed" | "modified";
  before?: string;
  after?: string;
};

export type WorkshopProposal = {
  id: string;
  summary: string;
  nextDraft: DraftPackage;
  baseDraft: DraftPackage;
  baseFingerprint: string;
  artifacts: ProposalArtifactDiff[];
  affectedStageIds: string[];
};

export type ChatMessage = {
  id: string;
  role: "assistant" | "user" | "system";
  text: string;
  artifacts?: ProposalArtifactDiff[];
};

export const WORKSHOP_AUTHOR_GREETING =
  "What are we building? Describe the workflow you want and I’ll propose stages and wiring for this draft.";

export const STALE_PROPOSAL_NOTICE =
  "Proposal discarded: the draft changed while it was pending. Rejected to avoid clobbering your edits.";

const DEFAULT_MODEL = "anthropic/claude-sonnet-4-5";

const REQUIRED_IO = {
  io: {
    input: { schema: { type: "object" } },
    output: { schema: { type: "object" } },
  },
};

let proposalSeq = 0;

export function emptyDraftPackage(id = "untitled"): DraftPackage {
  return {
    pipeline: {
      id,
      stages: [],
    },
  };
}

export function draftFingerprint(draft: DraftPackage): string {
  return JSON.stringify(draft);
}

function formatArtifact(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function diffDraftPackages(
  before: DraftPackage,
  after: DraftPackage,
): ProposalArtifactDiff[] {
  const diffs: ProposalArtifactDiff[] = [];
  const pipelinePath = `${after.pipeline.id || before.pipeline.id || "pipeline"}.pipeline.yaml`;
  if (JSON.stringify(before.pipeline) !== JSON.stringify(after.pipeline)) {
    diffs.push({
      path: pipelinePath,
      kind: "modified",
      before: formatArtifact(before.pipeline),
      after: formatArtifact(after.pipeline),
    });
  }

  const beforeStages = new Map(
    (before.stages ?? []).map((s) => [s.path, s] as const),
  );
  const afterStages = new Map(
    (after.stages ?? []).map((s) => [s.path, s] as const),
  );

  for (const [path, art] of afterStages) {
    const prev = beforeStages.get(path);
    if (!prev) {
      diffs.push({
        path,
        kind: "added",
        after: formatArtifact(art.body),
      });
    } else if (JSON.stringify(prev.body) !== JSON.stringify(art.body)) {
      diffs.push({
        path,
        kind: "modified",
        before: formatArtifact(prev.body),
        after: formatArtifact(art.body),
      });
    }
  }
  for (const [path, art] of beforeStages) {
    if (!afterStages.has(path)) {
      diffs.push({
        path,
        kind: "removed",
        before: formatArtifact(art.body),
      });
    }
  }

  const beforeTask = before.task
    ? formatArtifact({ filename: before.task.filename, body: before.task.body })
    : null;
  const afterTask = after.task
    ? formatArtifact({ filename: after.task.filename, body: after.task.body })
    : null;
  if (beforeTask !== afterTask) {
    const path =
      after.task?.filename ?? before.task?.filename ?? "task.task.yaml";
    if (!beforeTask && afterTask) {
      diffs.push({ path, kind: "added", after: afterTask });
    } else if (beforeTask && !afterTask) {
      diffs.push({ path, kind: "removed", before: beforeTask });
    } else {
      diffs.push({
        path,
        kind: "modified",
        before: beforeTask ?? undefined,
        after: afterTask ?? undefined,
      });
    }
  }

  return diffs;
}

export function affectedStageIds(
  before: DraftPackage,
  after: DraftPackage,
): string[] {
  const beforeSet = new Set(draftStageIds(before));
  const afterSet = new Set(draftStageIds(after));
  const ids = new Set<string>();
  for (const id of afterSet) {
    if (!beforeSet.has(id)) ids.add(id);
  }
  for (const id of beforeSet) {
    if (!afterSet.has(id)) ids.add(id);
  }

  const beforeByPath = new Map(
    (before.stages ?? []).map((s) => [s.path, s] as const),
  );
  for (const art of after.stages ?? []) {
    const prev = beforeByPath.get(art.path);
    if (!prev || JSON.stringify(prev.body) !== JSON.stringify(art.body)) {
      const id =
        typeof art.body.id === "string" && art.body.id
          ? art.body.id
          : undefined;
      if (id) ids.add(id);
    }
  }
  for (const art of before.stages ?? []) {
    if (!(after.stages ?? []).some((s) => s.path === art.path)) {
      const id =
        typeof art.body.id === "string" && art.body.id
          ? art.body.id
          : undefined;
      if (id) ids.add(id);
    }
  }

  for (let i = 0; i < after.pipeline.stages.length; i += 1) {
    const a = after.pipeline.stages[i]!;
    const b = before.pipeline.stages[i];
    const id = typeof a.id === "string" && a.id ? a.id : `stage-${i}`;
    if (!b || JSON.stringify(a) !== JSON.stringify(b)) {
      ids.add(id);
    }
  }

  return [...ids];
}

function slugifyStageId(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || "stage";
}

/** Client-side fake Workshop Author turn — mirrors src/operatorAgent fake host. */
export function proposeStageFromMessage(
  draft: DraftPackage,
  userText: string,
): WorkshopProposal {
  proposalSeq += 1;
  const existingIds = new Set(
    draft.pipeline.stages.map((s) => (typeof s.id === "string" ? s.id : "")),
  );
  let stageId = slugifyStageId(userText.split(/\s+/).slice(0, 3).join(" "));
  if (existingIds.has(stageId) || stageId === "untitled") {
    stageId = `${stageId}-${existingIds.size + 1}`;
  }

  const stageBody: Record<string, unknown> = {
    id: stageId,
    system_prompt: `Stage for: ${userText.trim() || "workshop draft"}`,
    model: DEFAULT_MODEL,
    ...REQUIRED_IO,
  };

  const usesPath = `./${stageId}.yaml`;
  const nextDraft: DraftPackage = {
    ...draft,
    pipeline: {
      ...draft.pipeline,
      stages: [
        ...draft.pipeline.stages,
        {
          id: stageId,
          uses: usesPath,
          ...(draft.pipeline.stages.length === 0 ? { entry: true } : {}),
        },
      ],
    },
    stages: [...(draft.stages ?? []), { path: usesPath, body: stageBody }],
  };

  return {
    id: `proposal-${proposalSeq}`,
    summary: `Add stage “${stageId}”`,
    nextDraft,
    baseDraft: draft,
    baseFingerprint: draftFingerprint(draft),
    artifacts: diffDraftPackages(draft, nextDraft),
    affectedStageIds: affectedStageIds(draft, nextDraft),
  };
}

function slugifyTaskId(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || "task";
}

function extractQuotedPhrase(text: string): string | null {
  const match = text.match(/["“]([^"”]+)["”]/);
  return match?.[1]?.trim() || null;
}

/** Detect clear NL requests to create or fill the draft task (vs stage proposals). */
export function isTaskProposalIntent(message: string): boolean {
  const text = message.trim().toLowerCase();
  if (!text) return false;
  return (
    /\b(create|add|make|attach|fill|set|write)\b[\s\w-]*\btask\b/.test(text) ||
    /\btask\b[\s\w-]*\b(create|add|fill|goal|brief)\b/.test(text) ||
    /\b(task brief|task package|task fields)\b/.test(text)
  );
}

/** Client-side fake Workshop Author turn for task create/fill. */
export function proposeTaskFromMessage(
  draft: DraftPackage,
  userText: string,
): WorkshopProposal {
  proposalSeq += 1;
  const quoted = extractQuotedPhrase(userText);
  const existingId =
    typeof draft.task?.body.id === "string" ? draft.task.body.id : "";
  const existingGoal =
    typeof draft.task?.body.goal === "string" ? draft.task.body.goal : "";

  let taskId = existingId;
  let goal = existingGoal;

  if (quoted) {
    if (!existingId || /\b(create|add|make|attach)\b/i.test(userText)) {
      taskId = slugifyTaskId(quoted);
    }
    goal = quoted;
  } else {
    const goalMatch = userText.match(
      /\b(?:goal|brief)\s*[:=]\s*(.+)$/i,
    );
    if (goalMatch?.[1]) {
      goal = goalMatch[1].trim();
    } else if (!goal) {
      goal = userText.trim() || "Describe the workflow goal";
    }
    if (!taskId) {
      taskId = slugifyTaskId(
        userText
          .replace(/\b(create|add|make|attach|fill|set|write|a|the|task|brief|goal|fields|package)\b/gi, " ")
          .trim() || "task",
      );
    }
  }

  if (!taskId) taskId = "task";
  if (!goal) goal = "Describe the workflow goal";

  const filename = `${taskId}.task.yaml`;
  const filling = Boolean(draft.task);
  const nextDraft: DraftPackage = {
    ...draft,
    task: {
      filename,
      body: {
        ...(draft.task?.body ?? {}),
        id: taskId,
        goal,
      },
    },
  };

  return {
    id: `proposal-${proposalSeq}`,
    summary: filling
      ? `Fill task “${taskId}”`
      : `Create task “${taskId}”`,
    nextDraft,
    baseDraft: draft,
    baseFingerprint: draftFingerprint(draft),
    artifacts: diffDraftPackages(draft, nextDraft),
    affectedStageIds: [],
  };
}

/** True when Save wrote a task and the draft still has one — offer New Run deep-link. */
export function canOfferRunShortcut(opts: {
  savedPipelinePath: string | null;
  savedTaskPath: string | null;
  hasTaskInDraft: boolean;
}): boolean {
  return Boolean(
    opts.savedPipelinePath &&
      opts.savedTaskPath &&
      opts.hasTaskInDraft,
  );
}

export function draftStageIds(draft: DraftPackage): string[] {
  return draft.pipeline.stages.map((stage, index) =>
    typeof stage.id === "string" && stage.id ? stage.id : `stage-${index}`,
  );
}

export function isProposalStale(
  proposal: WorkshopProposal,
  draft: DraftPackage,
): boolean {
  return proposal.baseFingerprint !== draftFingerprint(draft);
}

/** Parse clear NL requests that flip auto-apply. Returns null if not an auto-apply command. */
export function parseAutoApplyIntent(message: string): boolean | null {
  const text = message.trim().toLowerCase();
  if (!text) return null;

  if (
    /\b(disable|turn off|stop)\s+auto-?apply\b/.test(text) ||
    /\bauto-?apply\s+(off|disabled)\b/.test(text) ||
    /\brequire\s+(my\s+)?accept\b/.test(text) ||
    /\bdon'?t\s+auto-?apply\b/.test(text)
  ) {
    return false;
  }

  if (
    /\b(enable|turn on|start)\s+auto-?apply\b/.test(text) ||
    /\bauto-?apply\s+(on|enabled|chat edits)\b/.test(text) ||
    /\bjust\s+apply\s+(changes|edits|proposals)\b/.test(text) ||
    /\bapply\s+(changes|edits)\s+automatically\b/.test(text) ||
    /\bauto-?apply\s+chat\s+edits\b/.test(text)
  ) {
    return true;
  }

  return null;
}

export function autoApplyStatusMessage(enabled: boolean): string {
  return enabled
    ? "Auto-apply chat edits is on. Further proposals will update the draft without Accept. Save remains explicit — nothing is written to disk until you Save."
    : "Auto-apply chat edits is off. Proposals will wait for Accept or Reject.";
}

export function formatArtifactDiffLine(diff: ProposalArtifactDiff): string {
  const mark =
    diff.kind === "added" ? "+" : diff.kind === "removed" ? "-" : "~";
  return `${mark} ${diff.path} (${diff.kind})`;
}
