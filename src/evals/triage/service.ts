import { randomBytes } from "node:crypto";
import { newAgentDefinition } from "../../config/loadAgent.js";
import type { ConversationBackend } from "../../agents/runtime/types.js";
import type { RunStore } from "../../runstore/port.js";
import { EvalApiError } from "../read/api.js";
import {
  buildSuggestionSummary,
  suggestionToWire,
  type SuggestionSummary,
  type WireSuggestion,
} from "../read/suggestions.js";
import { createBackendSimulatorModel, type ModelPrice, type SimulatorModel } from "../runner/simulatorModel.js";
import { EXECUTED_RESULT_STATUSES } from "../statsTypes.js";
import type { EvalRunRow } from "../storeTypes.js";
import { TRIAGE_PROMPT_VERSION } from "../constants.js";
import {
  LOW_CONFIDENCE_THRESHOLD,
  TRIAGE_CONCURRENCY,
  TRIAGE_DEFAULT_LIMIT,
  TRIAGE_MAX_LIMIT,
  TRIAGE_BUCKETS,
  type SuggestionStatus,
  type TriageBucket,
  type TriageSource,
  JEV_MODEL_ID,
} from "./constants.js";
import { resolveTypesafeKey, type TypesafeKeyResolver } from "./credentials.js";
import { createJevClassifier } from "./jevClassifier.js";
import { createJudgeClassifier } from "./judgeClassifier.js";
import { buildTriageState } from "./stateBuilder.js";
import { ClassifierError, type FailureClassifier, type SuggestionInput } from "./types.js";

export type TriageDeps = {
  store: RunStore;
  /** Defaults to the stored `typesafe` credential, then the env names in `TYPESAFE_KEY_ENV_NAMES`. */
  resolveKey?: TypesafeKeyResolver;
  fetch?: typeof fetch;
  jevBaseUrl?: string;
  sleep?: (ms: number) => Promise<void>;
  /** The Host's agent backend; its one-shot call runs the judge classifier. */
  judgeBackend?: () => ConversationBackend | undefined;
  /** Replaces the backend-built judge model (tests). */
  judgeModel?: (input: { projectRoot: string; modelId: string }) => SimulatorModel | undefined;
  loadPrices?: (modelIds: string[], projectRoot: string) => Promise<Map<string, ModelPrice>>;
};

export type ClassifierRequest = "auto" | "jev" | "judge";

export type ClassifierStatus = { available: boolean; model: string | null; reason?: string };
export type TriageStatus = {
  classifiers: {
    jev: ClassifierStatus & { key_sources: string[] };
    judge: ClassifierStatus;
  };
  default: TriageSource | null;
};

export type SortOptions = { classifier?: ClassifierRequest; onlyUnsorted?: boolean; limit?: number };

export type SortResult = {
  batch_id: string;
  classifier: TriageSource;
  model: string;
  sorted: number;
  skipped: number;
  failed: number;
  triage_cost_usd: number;
  suggestions: WireSuggestion[];
};

export type AcceptRequest = { ids?: string[]; minConfidence?: number; bucket?: TriageBucket };

const JUDGE_MISSING = "Add a judge model to the eval (defaults.judge) or run Stageflow with an agent backend that can make a model call.";
const KEY_MISSING =
  "Add a TypeSafe key: Settings, Providers, TypeSafe, or set STAGEFLOW_PROVIDER_TYPESAFE_API_KEY (also read: TYPESAFE_API_KEY, JEV_API_KEY).";

function judgeModelIdOf(run: EvalRunRow): string | null {
  const settings = (run.config as { settings?: { judge?: unknown } }).settings;
  const id = settings?.judge;
  return typeof id === "string" && id.includes("/") ? id : null;
}

function graderDefinitionsOf(run: EvalRunRow): unknown[] {
  const definition = (run.config as { eval?: { definition?: { graders?: unknown } } }).eval?.definition;
  return Array.isArray(definition?.graders) ? definition.graders : [];
}

async function pool<T>(items: readonly T[], size: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next++] as T;
      await work(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, lane));
}

export class TriageService {
  constructor(private readonly deps: TriageDeps) {}

  private keyLookup(projectRoot: string) {
    return (this.deps.resolveKey ?? ((root) => resolveTypesafeKey(root)))(projectRoot);
  }

  private judgeModelFor(
    projectRoot: string,
    modelId: string,
    prices?: Map<string, ModelPrice>,
  ): SimulatorModel | undefined {
    if (this.deps.judgeModel) return this.deps.judgeModel({ projectRoot, modelId });
    const backend = this.deps.judgeBackend?.();
    if (backend?.judge === undefined) return undefined;
    const parsed = newAgentDefinition({
      id: "failure_sorter",
      name: "Failure sorter",
      instructions: "Sort failed evaluation results into buckets.",
    });
    if (!parsed.ok) return undefined;
    return createBackendSimulatorModel({
      backend,
      projectRoot,
      definition: parsed.value,
      modelId,
      priceOf: (id) => prices?.get(id),
    });
  }

  async status(run: EvalRunRow): Promise<TriageStatus> {
    const lookup = await this.keyLookup(run.projectRoot);
    const jevAvailable = lookup.key !== undefined;
    const judgeId = judgeModelIdOf(run);
    const judgeAvailable = judgeId !== null && this.judgeModelFor(run.projectRoot, judgeId) !== undefined;
    return {
      classifiers: {
        jev: {
          available: jevAvailable,
          model: JEV_MODEL_ID,
          key_sources: lookup.sources,
          ...(jevAvailable ? {} : { reason: KEY_MISSING }),
        },
        judge: {
          available: judgeAvailable,
          model: judgeId,
          ...(judgeAvailable ? {} : { reason: judgeId === null ? "This eval run has no judge model." : JUDGE_MISSING }),
        },
      },
      default: jevAvailable ? "jev" : judgeAvailable ? "judge" : null,
    };
  }

  private async classifierFor(run: EvalRunRow, requested: ClassifierRequest): Promise<FailureClassifier> {
    const status = await this.status(run);
    const choice: TriageSource | null = requested === "auto" ? status.default : requested;
    if (choice === "jev" && status.classifiers.jev.available) {
      const lookup = await this.keyLookup(run.projectRoot);
      return createJevClassifier({
        apiKey: lookup.key as string,
        ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}),
        ...(this.deps.jevBaseUrl ? { baseUrl: this.deps.jevBaseUrl } : {}),
        ...(this.deps.sleep ? { sleep: this.deps.sleep } : {}),
      });
    }
    if (choice === "judge" && status.classifiers.judge.available) {
      const modelId = judgeModelIdOf(run) as string;
      const prices = await this.deps.loadPrices?.([modelId], run.projectRoot).catch(() => undefined);
      return createJudgeClassifier({
        model: this.judgeModelFor(run.projectRoot, modelId, prices) as SimulatorModel,
        modelId,
      });
    }
    const missing = choice === "judge" ? "judge_model" : "typesafe_key";
    throw new EvalApiError(
      422,
      "EVAL_CLASSIFIER_UNAVAILABLE",
      requested === "auto" ? `No classifier is available. ${KEY_MISSING} Or ${JUDGE_MISSING}` : choice === "judge" ? JUDGE_MISSING : KEY_MISSING,
      { missing },
    );
  }

  async sort(run: EvalRunRow, options: SortOptions = {}): Promise<SortResult> {
    if (run.status === "queued" || run.status === "running") {
      throw new EvalApiError(409, "EVAL_RUN_ACTIVE", "Eval run is still running; wait for it to finish");
    }
    const classifier = await this.classifierFor(run, options.classifier ?? "auto");
    const onlyUnsorted = options.onlyUnsorted ?? true;
    const limit = Math.min(Math.max(1, options.limit ?? TRIAGE_DEFAULT_LIMIT), TRIAGE_MAX_LIMIT);
    const { store } = this.deps;
    const [results, cases, existing] = await Promise.all([
      store.listEvalResults(run.evalRunId),
      store.getEvalCases(run.evalRunId),
      store.listEvalSuggestions(run.evalRunId),
    ]);
    const caseById = new Map(cases.map((c) => [c.caseId, c]));
    const have = new Map(
      existing.filter((s) => s.source === classifier.source).map((s) => [`${s.caseId}\u0000${s.repeatIndex}`, s]),
    );
    const failedResults = results
      .filter((r) => !r.passed && EXECUTED_RESULT_STATUSES.includes(r.status))
      .sort((a, b) => a.caseId.localeCompare(b.caseId) || a.repeatIndex - b.repeatIndex);

    let skipped = 0;
    const todo = failedResults.filter((r) => {
      const prior = have.get(`${r.caseId}\u0000${r.repeatIndex}`);
      const skip = prior !== undefined && (prior.status !== "pending" || onlyUnsorted);
      if (skip) skipped += 1;
      return !skip;
    });
    const batch = todo.slice(0, limit);
    skipped += todo.length - batch.length;

    const batchId = `sb_${randomBytes(6).toString("hex")}`;
    const graderDefinitions = graderDefinitionsOf(run);
    const inputs: SuggestionInput[] = [];
    let failed = 0;
    let costUsd = 0;
    await pool(batch, TRIAGE_CONCURRENCY, async (result) => {
      const built = buildTriageState({
        targetKind: run.targetKind,
        caseRow: caseById.get(result.caseId),
        result,
        graderDefinitions,
      });
      try {
        const out = await classifier.classify({
          targetKind: run.targetKind,
          state: built.state,
          graderQuestions: built.graderQuestions,
        });
        costUsd += out.costUsd;
        inputs.push({
          caseId: result.caseId,
          repeatIndex: result.repeatIndex,
          source: classifier.source,
          bucket: out.bucket,
          failureType: out.failureType,
          confidence: out.confidence,
          bucketProbabilities: out.bucketProbabilities,
          graderFalseAlarms: out.graderFalseAlarms,
          model: out.answeredModel ?? classifier.model,
          promptVersion: TRIAGE_PROMPT_VERSION,
          batchId,
          costUsd: out.costUsd,
          stateTruncated: built.truncated,
        });
      } catch (err) {
        if (!(err instanceof ClassifierError)) throw err;
        failed += 1;
      }
    });
    inputs.sort((a, b) => a.caseId.localeCompare(b.caseId) || a.repeatIndex - b.repeatIndex);
    const written = await store.upsertEvalSuggestions(run.evalRunId, inputs);
    return {
      batch_id: batchId,
      classifier: classifier.source,
      model: classifier.model,
      sorted: written.length,
      skipped,
      failed,
      triage_cost_usd: costUsd,
      suggestions: written.map(suggestionToWire),
    };
  }

  async list(run: EvalRunRow, status?: SuggestionStatus): Promise<{ items: WireSuggestion[]; summary: SuggestionSummary }> {
    const all = await this.deps.store.listEvalSuggestions(run.evalRunId);
    return {
      items: all.filter((s) => status === undefined || s.status === status).map(suggestionToWire),
      summary: buildSuggestionSummary(all),
    };
  }

  async accept(run: EvalRunRow, request: AcceptRequest): Promise<{ accepted: number; tagged: number }> {
    let ids = request.ids;
    if (ids === undefined) {
      const min = request.minConfidence ?? LOW_CONFIDENCE_THRESHOLD;
      const pending = await this.deps.store.listEvalSuggestions(run.evalRunId, "pending");
      ids = pending
        .filter(
          (s) =>
            s.bucket !== "unclear" &&
            s.confidence >= min &&
            (request.bucket === undefined || s.bucket === request.bucket),
        )
        .map((s) => s.id);
    }
    return this.deps.store.acceptEvalSuggestions(run.evalRunId, ids);
  }

  async dismiss(run: EvalRunRow, ids: string[]): Promise<{ dismissed: number }> {
    return { dismissed: await this.deps.store.dismissEvalSuggestions(run.evalRunId, ids) };
  }
}

export function isTriageBucket(value: unknown): value is TriageBucket {
  return typeof value === "string" && (TRIAGE_BUCKETS as readonly string[]).includes(value);
}
