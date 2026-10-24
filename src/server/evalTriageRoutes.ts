import { EvalApiError } from "../evals/read/api.js";
import { SUGGESTION_STATUSES, TRIAGE_BUCKETS, TRIAGE_MAX_LIMIT } from "../evals/triage/constants.js";
import { isTriageBucket, TriageService, type ClassifierRequest } from "../evals/triage/service.js";
import { audit, bad, optStringArray, readOptionalBody, runByIdOr404, type Ctx } from "./evalRouteContext.js";

function triageOf(c: Ctx): TriageService {
  return new TriageService({ store: c.store, ...(c.triage ?? {}), loadPrices: c.triage?.loadPrices ?? c.loadPrices });
}

async function handleSort(c: Ctx, id: string): Promise<void> {
  const body = await readOptionalBody(c);
  const row = await runByIdOr404(c, id);
  const classifier = body.classifier ?? "auto";
  if (classifier !== "auto" && classifier !== "jev" && classifier !== "judge") {
    throw bad(`"classifier" must be auto, jev or judge`);
  }
  if (body.only_unsorted !== undefined && typeof body.only_unsorted !== "boolean") throw bad(`"only_unsorted" must be a boolean`);
  if (
    body.limit !== undefined &&
    (typeof body.limit !== "number" || !Number.isInteger(body.limit) || body.limit < 1 || body.limit > TRIAGE_MAX_LIMIT)
  ) {
    throw bad(`"limit" must be an integer from 1 to ${TRIAGE_MAX_LIMIT}`);
  }
  try {
    const result = await triageOf(c).sort(row, {
      classifier: classifier as ClassifierRequest,
      ...(body.only_unsorted !== undefined ? { onlyUnsorted: body.only_unsorted as boolean } : {}),
      ...(body.limit !== undefined ? { limit: body.limit as number } : {}),
    });
    audit(c, "eval_failures_sort", "ok", id);
    c.json(c.res, 200, result);
  } catch (err) {
    audit(c, "eval_failures_sort", "error", id, err instanceof EvalApiError ? err.code : "internal_error");
    throw err;
  }
}

async function handleSuggestionsList(c: Ctx, id: string): Promise<void> {
  const row = await runByIdOr404(c, id);
  const status = c.url.searchParams.get("status") ?? undefined;
  if (status !== undefined && !(SUGGESTION_STATUSES as readonly string[]).includes(status)) {
    throw bad(`"status" must be one of ${SUGGESTION_STATUSES.join(", ")}`);
  }
  c.json(c.res, 200, await triageOf(c).list(row, status as (typeof SUGGESTION_STATUSES)[number] | undefined));
}

function idsOf(body: Record<string, unknown>, required: boolean): string[] | undefined {
  const ids = optStringArray(body, "ids");
  if (ids === undefined && required) throw bad(`"ids" is required`);
  return ids;
}

async function handleSuggestionsAccept(c: Ctx, id: string): Promise<void> {
  const body = await readOptionalBody(c);
  const row = await runByIdOr404(c, id);
  const ids = idsOf(body, false);
  if (body.min_confidence !== undefined && (typeof body.min_confidence !== "number" || body.min_confidence < 0 || body.min_confidence > 1)) {
    throw bad(`"min_confidence" must be a number from 0 to 1`);
  }
  if (body.bucket !== undefined && !isTriageBucket(body.bucket)) throw bad(`"bucket" must be one of ${TRIAGE_BUCKETS.join(", ")}`);
  const result = await triageOf(c).accept(row, {
    ...(ids !== undefined ? { ids } : {}),
    ...(typeof body.min_confidence === "number" ? { minConfidence: body.min_confidence } : {}),
    ...(isTriageBucket(body.bucket) ? { bucket: body.bucket } : {}),
  });
  audit(c, "eval_suggestions_accept", "ok", id);
  c.json(c.res, 200, result);
}

async function handleSuggestionsDismiss(c: Ctx, id: string): Promise<void> {
  const body = await readOptionalBody(c);
  const row = await runByIdOr404(c, id);
  const result = await triageOf(c).dismiss(row, idsOf(body, true) as string[]);
  audit(c, "eval_suggestions_dismiss", "ok", id);
  c.json(c.res, 200, result);
}

async function handleSortStatus(c: Ctx, id: string): Promise<void> {
  c.json(c.res, 200, await triageOf(c).status(await runByIdOr404(c, id)));
}


export function matchEvalTriageRoute(c: Ctx, seg: (value: string | undefined) => string): (() => Promise<void>) | undefined {
  const { method, pathname } = c;
  const m = (re: RegExp): RegExpMatchArray | null => pathname.match(re);
  let match = m(/^\/api\/eval-runs\/([^/]+)\/failures\/sort$/);
  if (method === "POST" && match) return () => handleSort(c, seg(match![1]));
  match = m(/^\/api\/eval-runs\/([^/]+)\/failures\/suggestions$/);
  if (method === "GET" && match) return () => handleSuggestionsList(c, seg(match![1]));
  match = m(/^\/api\/eval-runs\/([^/]+)\/failures\/suggestions\/accept$/);
  if (method === "POST" && match) return () => handleSuggestionsAccept(c, seg(match![1]));
  match = m(/^\/api\/eval-runs\/([^/]+)\/failures\/suggestions\/dismiss$/);
  if (method === "POST" && match) return () => handleSuggestionsDismiss(c, seg(match![1]));
  match = m(/^\/api\/eval-runs\/([^/]+)\/failures\/status$/);
  if (method === "GET" && match) return () => handleSortStatus(c, seg(match![1]));
  return undefined;
}
