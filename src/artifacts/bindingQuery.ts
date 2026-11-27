import type Database from "better-sqlite3";
import type { FunctionDefinition } from "../config/loadFunction.js";
import { createFunctionInvoker } from "../functions/invoke.js";
import { argsFailure } from "./bindings.js";
import { expiredContentMessage } from "./content.js";
import { loadStoredLiveBindings } from "./htmlManifest.js";
import { isLiveKind } from "./kinds.js";
import { LIVE_BINDING_ARGS_MAX_BYTES, ArtifactPublishError } from "./limits.js";
import { argsHash, type LiveBinding, type LiveBindingSet } from "./manifest.js";
import { ArtifactQueryError } from "./query.js";
import type { ArtifactOwner } from "./record.js";
import {
  effectiveTtlSeconds,
  REFRESH_RETRY_AFTER_SECONDS,
  snapshotNeedsRefresh,
  type ArtifactSnapshotSource,
} from "./refreshPolicy.js";
import { coordinateRefresh, type RefreshShareOptions } from "./refreshShare.js";
import {
  executeLiveBinding,
  loadPinnedFunction,
  projectMatches,
  refreshArtifact,
  type ArtifactRefreshDeps,
  type ArtifactRefreshResult,
} from "./refresh.js";

/** Levels 3 (writes) and 4 (ask the agent) are specified and not available. */
export const ARTIFACT_INTERACTION_DISABLED = "artifact.interaction_disabled";

export const VARIANT_SNAPSHOTS_PER_BINDING = 32;
export const VARIANT_EXECUTIONS_PER_MINUTE = 30;
export const VARIANT_IN_FLIGHT_PER_ARTIFACT = 10;
export const VARIANT_RATE_WINDOW_MS = 60_000;
export const VIEWER_EXECUTIONS_GLOBAL = 6;
export const VIEWER_VARIANT_EXECUTIONS_PER_MINUTE_GLOBAL = 120;
const BUDGET_PRUNE_PER_ADMISSION = 5_000;
export const VIEWER_ARGS_MAX_KEYS = 16;
export const VIEWER_ARGS_MAX_DEPTH = 8;

const VIEWER_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

export type BindingQueryRequest = {
  bindingId: string;
  args?: Record<string, unknown>;
  ifStale?: boolean;
  signal?: AbortSignal;
};

export type BindingQuerySnapshot = {
  value: unknown;
  fetched_at: string;
  duration_ms: number;
  status: string;
  error_code: string | null;
  source: ArtifactSnapshotSource;
};

export type BindingQueryResult = {
  binding_id: string;
  args_hash: string;
  snapshot: BindingQuerySnapshot | null;
  errors: Array<{ binding_id: string; code: string }>;
  retry_after_seconds?: number;
};

type SnapshotRow = {
  binding_id: string;
  args_hash: string;
  value_json: string | null;
  fetched_at: string;
  duration_ms: number;
  status: string;
  error_code: string | null;
};

type ArtifactLiveRow = {
  kind: string;
  owner_kind: string;
  owner_pipeline: string | null;
  owner_stage: string | null;
  owner_agent: string | null;
  project_root_id: string;
  current_version: number;
  status: string | null;
  expired_reason: string | null;
  manifest_json: string | null;
  live_status: string | null;
  last_refreshed_at: string | null;
  last_error_code: string | null;
  deleted_at: string | null;
};

type VariantBudget = {
  inFlight: number;
  startedAt: number[];
};

const budgets = new Map<string, VariantBudget>();
let viewerInFlight = 0;
const viewerVariantStartedAt: number[] = [];

export function resetBindingQueryForTests(): void {
  budgets.clear();
  viewerInFlight = 0;
  viewerVariantStartedAt.length = 0;
}

export function bindingQueryBudgetSize(): number {
  return budgets.size;
}

export function seedBindingQueryBudgetForTests(key: string, startedAtMs: number, inFlight = 0): void {
  budgets.set(key, { inFlight, startedAt: [startedAtMs] });
}

export function variantExecutionIdle(): boolean {
  if (viewerInFlight > 0) return false;
  for (const budget of budgets.values()) {
    if (budget.inFlight > 0) return false;
  }
  return true;
}

export function bindingQueryHttpStatus(result: BindingQueryResult): 200 | 503 {
  const limited = result.errors.some((error) => error.code === "artifact.resource_limit");
  if (!limited) return 200;
  return result.snapshot?.status === "ok" ? 200 : 503;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}


function ownerOf(row: ArtifactLiveRow): ArtifactOwner {
  if (row.owner_kind === "agent") return { kind: "agent", agent: row.owner_agent ?? "" };
  if (row.owner_kind === "guide") return { kind: "guide" };
  return { kind: "stage", pipeline: row.owner_pipeline ?? "", stage: row.owner_stage ?? "" };
}

function loadRow(db: Database.Database, key: string): ArtifactLiveRow | undefined {
  return db
    .prepare(
      `SELECT a.kind, a.owner_kind, a.owner_pipeline, a.owner_stage, a.owner_agent,
              a.project_root_id, a.current_version, a.status, a.expired_reason,
              a.live_status, a.last_refreshed_at, a.last_error_code, a.deleted_at,
              v.manifest_json
         FROM artifacts a
         LEFT JOIN artifact_versions v ON v.key = a.key AND v.version = a.current_version
        WHERE a.key = ?`,
    )
    .get(key) as ArtifactLiveRow | undefined;
}

function assertLiveRow(row: ArtifactLiveRow | undefined, projectRoot: string, projectId?: string): ArtifactLiveRow {
  if (!row || row.deleted_at || !projectMatches(row.project_root_id, projectRoot, projectId)) {
    throw new ArtifactQueryError(404, "artifact.not_found", "Artifact not found");
  }
  if (!isLiveKind(row.kind)) {
    throw new ArtifactQueryError(404, "artifact.not_live", "Artifact is not live");
  }
  if (row.status === "expired") {
    throw new ArtifactQueryError(404, "artifact.content_unavailable", expiredContentMessage(row.expired_reason));
  }
  return row;
}

function snapshotRow(db: Database.Database, key: string, bindingId: string, hash: string): SnapshotRow | undefined {
  return db
    .prepare(
      `SELECT binding_id, args_hash, value_json, fetched_at, duration_ms, status, error_code
         FROM artifact_snapshots
        WHERE artifact_key = ? AND binding_id = ? AND args_hash = ?`,
    )
    .get(key, bindingId, hash) as SnapshotRow | undefined;
}

function snapshotView(row: SnapshotRow, source: ArtifactSnapshotSource): BindingQuerySnapshot {
  let value: unknown = null;
  if (row.value_json) {
    try {
      value = JSON.parse(row.value_json) as unknown;
    } catch {
      value = null;
    }
  }
  return {
    value,
    fetched_at: row.fetched_at,
    duration_ms: row.duration_ms,
    status: row.status,
    error_code: row.error_code,
    source,
  };
}

function finish(result: BindingQueryResult): BindingQueryResult {
  if (result.errors.some((error) => error.code === "artifact.resource_limit")) {
    result.retry_after_seconds = REFRESH_RETRY_AFTER_SECONDS;
  }
  return result;
}

function walkViewer(value: unknown, depth: number, issuePath: string): { path: string; message: string } | undefined {
  if (depth > VIEWER_ARGS_MAX_DEPTH) {
    return { path: issuePath, message: `is deeper than ${VIEWER_ARGS_MAX_DEPTH}` };
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return undefined;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return { path: issuePath, message: "must be a JSON value" };
    return undefined;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const issue = walkViewer(value[index], depth + 1, `${issuePath}[${index}]`);
      if (issue) return issue;
    }
    return undefined;
  }
  if (!isRecord(value)) return { path: issuePath, message: "must be a JSON value" };
  for (const key of Object.keys(value)) {
    if (!VIEWER_KEY_RE.test(key)) {
      return { path: `${issuePath}.${key}`, message: "is not a valid argument name" };
    }
    const issue = walkViewer(value[key], depth + 1, `${issuePath}.${key}`);
    if (issue) return issue;
  }
  return undefined;
}

export function viewerArgsIssue(args: unknown): { path: string; message: string } | undefined {
  if (args === undefined) return undefined;
  if (!isRecord(args)) return { path: "args", message: "must be an object" };
  const keys = Object.keys(args);
  if (keys.length > VIEWER_ARGS_MAX_KEYS) {
    return { path: "args", message: `has more than ${VIEWER_ARGS_MAX_KEYS} keys` };
  }
  const shape = walkViewer(args, 1, "args");
  if (shape) return shape;
  let encoded: string;
  try {
    encoded = JSON.stringify(args);
  } catch {
    return { path: "args", message: "must be JSON" };
  }
  if (Buffer.byteLength(encoded, "utf8") > LIVE_BINDING_ARGS_MAX_BYTES) {
    return { path: "args", message: "is larger than 8 KiB" };
  }
  return undefined;
}

function throwArgs(issue: { path: string; message: string }): never {
  throw new ArtifactPublishError(400, "artifact.binding_args_invalid", "Binding arguments are not valid", [issue]);
}

function mergeArgs(defaults: Record<string, unknown>, viewer: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!viewer) return { ...defaults };
  return { ...defaults, ...viewer };
}

function defaultInvoke(db: Database.Database): NonNullable<ArtifactRefreshDeps["invoke"]> {
  const invoker = createFunctionInvoker({ db });
  return (projectRoot, input) => invoker.call(projectRoot, input);
}

function capacityResult(db: Database.Database, key: string, bindingId: string, hash: string): BindingQueryResult {
  const row = snapshotRow(db, key, bindingId, hash);
  return finish({
    binding_id: bindingId,
    args_hash: hash,
    snapshot: row ? snapshotView(row, "cache") : null,
    errors: [{ binding_id: bindingId, code: "artifact.resource_limit" }],
  });
}

function fromRefresh(bindingId: string, hash: string, result: ArtifactRefreshResult): BindingQueryResult {
  const snapshot = result.snapshots.find((item) => item.binding_id === bindingId && item.args_hash === hash);
  return finish({
    binding_id: bindingId,
    args_hash: hash,
    snapshot: snapshot
      ? {
          value: snapshot.value,
          fetched_at: snapshot.fetched_at,
          duration_ms: snapshot.duration_ms,
          status: snapshot.status,
          error_code: snapshot.error_code,
          source: snapshot.source ?? "cache",
        }
      : null,
    errors: result.errors.filter((error) => error.binding_id === bindingId),
    ...(result.retry_after_seconds !== undefined ? { retry_after_seconds: result.retry_after_seconds } : {}),
  });
}

function pruneViewerRate(nowMs: number): void {
  const fresh = viewerVariantStartedAt.filter((started) => nowMs - started < VARIANT_RATE_WINDOW_MS);
  if (fresh.length !== viewerVariantStartedAt.length) {
    viewerVariantStartedAt.length = 0;
    viewerVariantStartedAt.push(...fresh);
  }
}

function pruneBudgets(nowMs: number): void {
  let scanned = 0;
  for (const [key, budget] of budgets) {
    if (scanned >= BUDGET_PRUNE_PER_ADMISSION) break;
    scanned += 1;
    const fresh = budget.startedAt.filter((started) => nowMs - started < VARIANT_RATE_WINDOW_MS);
    if (fresh.length !== budget.startedAt.length) budget.startedAt = fresh;
    if (budget.inFlight === 0 && budget.startedAt.length === 0) budgets.delete(key);
  }
}

function rememberBudget(artifactKey: string, budget: VariantBudget): void {
  if (budget.inFlight === 0 && budget.startedAt.length === 0) budgets.delete(artifactKey);
  else budgets.set(artifactKey, budget);
}

function tryAcquireVariant(artifactKey: string, nowMs: number): boolean {
  pruneBudgets(nowMs);
  pruneViewerRate(nowMs);
  const budget = budgets.get(artifactKey) ?? { inFlight: 0, startedAt: [] };
  budget.startedAt = budget.startedAt.filter((started) => nowMs - started < VARIANT_RATE_WINDOW_MS);
  if (budget.inFlight >= VARIANT_IN_FLIGHT_PER_ARTIFACT || budget.startedAt.length >= VARIANT_EXECUTIONS_PER_MINUTE) {
    rememberBudget(artifactKey, budget);
    return false;
  }
  if (
    viewerInFlight >= VIEWER_EXECUTIONS_GLOBAL ||
    viewerVariantStartedAt.length >= VIEWER_VARIANT_EXECUTIONS_PER_MINUTE_GLOBAL
  ) {
    rememberBudget(artifactKey, budget);
    return false;
  }
  budget.inFlight += 1;
  budget.startedAt.push(nowMs);
  budgets.set(artifactKey, budget);
  viewerInFlight += 1;
  viewerVariantStartedAt.push(nowMs);
  return true;
}

function tryAcquireForcedViewer(nowMs: number): boolean {
  pruneBudgets(nowMs);
  pruneViewerRate(nowMs);
  if (viewerInFlight >= VIEWER_EXECUTIONS_GLOBAL) return false;
  viewerInFlight += 1;
  return true;
}

function releaseVariant(artifactKey: string): void {
  viewerInFlight = Math.max(0, viewerInFlight - 1);
  const budget = budgets.get(artifactKey);
  if (!budget) return;
  budget.inFlight = Math.max(0, budget.inFlight - 1);
  if (budget.inFlight === 0 && budget.startedAt.length === 0) budgets.delete(artifactKey);
}

function releaseForcedViewer(): void {
  viewerInFlight = Math.max(0, viewerInFlight - 1);
}

function cacheResult(bindingId: string, hash: string, row: SnapshotRow): BindingQueryResult {
  return {
    binding_id: bindingId,
    args_hash: hash,
    snapshot: snapshotView(row, "cache"),
    errors: [],
  };
}

/**
 * TODO(multi-tenant): viewer scope is not part of this key, the snapshot row, or the
 * per-artifact rate limit. A variant is shared by every viewer because the call uses
 * the function's own access. That is safe only in the single-user control-token model (D13).
 */
function variantFlightKey(storageKey: string, bindingId: string, hash: string): string {
  return `variant\u0000${storageKey}\u0000${bindingId}\u0000${hash}`;
}

function storeVariant(
  db: Database.Database,
  deps: ArtifactRefreshDeps,
  key: string,
  bindingId: string,
  defaultHash: string,
  hash: string,
  valueJson: string,
  duration: number,
  startedVersion: number,
): "stored" | "missing" | "superseded" {
  const now = deps.now ?? (() => new Date().toISOString());
  return db.transaction(() => {
    const current = loadRow(db, key);
    if (!current || current.deleted_at || !projectMatches(current.project_root_id, deps.projectRoot, deps.projectId)) return "missing";
    if (current.current_version !== startedVersion) return "superseded";
    const existing = snapshotRow(db, key, bindingId, hash);
    if (!existing) {
      const variants = db
        .prepare(
          `SELECT args_hash
             FROM artifact_snapshots
            WHERE artifact_key = ? AND binding_id = ? AND args_hash != ?
            ORDER BY fetched_at ASC, args_hash ASC`,
        )
        .all(key, bindingId, defaultHash) as Array<{ args_hash: string }>;
      if (variants.length >= VARIANT_SNAPSHOTS_PER_BINDING) {
        const victim = variants[0]!;
        db.prepare(
          `DELETE FROM artifact_snapshots WHERE artifact_key = ? AND binding_id = ? AND args_hash = ?`,
        ).run(key, bindingId, victim.args_hash);
      }
    }
    const fetchedAt = now();
    db.prepare(
      `INSERT INTO artifact_snapshots (
         artifact_key, binding_id, args_hash, value_json, fetched_at, duration_ms, status, error_code
       ) VALUES (
         @artifact_key, @binding_id, @args_hash, @value_json, @fetched_at, @duration_ms, 'ok', NULL
       )
       ON CONFLICT(artifact_key, binding_id, args_hash) DO UPDATE SET
         value_json = excluded.value_json,
         fetched_at = excluded.fetched_at,
         duration_ms = excluded.duration_ms,
         status = 'ok',
         error_code = NULL`,
    ).run({
      artifact_key: key,
      binding_id: bindingId,
      args_hash: hash,
      value_json: valueJson,
      fetched_at: fetchedAt,
      duration_ms: Math.max(0, Math.round(duration)),
    });
    return "stored";
  }).immediate();
}

export async function queryBinding(
  db: Database.Database,
  deps: ArtifactRefreshDeps,
  storageKey: string,
  request: BindingQueryRequest,
): Promise<BindingQueryResult> {
  const row = assertLiveRow(loadRow(db, storageKey), deps.projectRoot, deps.projectId);
  const manifest = loadStoredLiveBindings(row.manifest_json);
  if (!manifest) {
    throw new ArtifactPublishError(400, "artifact.invalid_shape", "Live artifact manifest is not valid", [
      { path: "manifest", message: "Live artifact manifest is not valid" },
    ]);
  }
  if (typeof request.bindingId !== "string" || request.bindingId.length === 0) {
    throw new ArtifactPublishError(400, "artifact.invalid_shape", "binding_id is required", [
      { path: "binding_id", message: "is required" },
    ]);
  }
  const index = manifest.bindings.findIndex((binding) => binding.id === request.bindingId);
  if (index < 0) {
    throw new ArtifactPublishError(400, "artifact.invalid_shape", "Unknown binding id", [
      { path: "binding_id", message: `Unknown binding ${request.bindingId}` },
    ]);
  }
  const binding = manifest.bindings[index]!;
  const viewerIssue = viewerArgsIssue(request.args);
  if (viewerIssue) throwArgs(viewerIssue);
  const viewer = request.args;
  const merged = mergeArgs(binding.args, viewer);
  const pinned = await loadPinnedFunction(db, deps.projectRoot, binding.function);
  if (pinned) {
    const failure = argsFailure(pinned.definition, merged, "args");
    if (failure) {
      throw new ArtifactPublishError(failure.status, failure.code, failure.message, failure.issues);
    }
  }
  const hash = argsHash(merged);
  const ifStale = request.ifStale !== false;
  if (hash === argsHash(binding.args)) {
    const nowIso = (deps.now ?? (() => new Date().toISOString()))();
    const parsedNow = Date.parse(nowIso);
    const nowMs = Number.isFinite(parsedNow) ? parsedNow : Date.now();
    const forced = !ifStale;
    if (forced && !tryAcquireForcedViewer(nowMs)) return capacityResult(db, storageKey, binding.id, hash);
    try {
      const refreshed = await refreshArtifact(db, deps, storageKey, {
        bindingIds: [binding.id],
        ...(ifStale ? { ifStale: true } : {}),
        ...(request.signal ? { signal: request.signal } : {}),
      });
      return fromRefresh(binding.id, hash, refreshed);
    } finally {
      if (forced) releaseForcedViewer();
    }
  }
  return runVariant(db, deps, storageKey, manifest, binding, index, merged, hash, ifStale, request.signal, pinned);
}

async function runVariant(
  db: Database.Database,
  deps: ArtifactRefreshDeps,
  storageKey: string,
  manifest: LiveBindingSet,
  binding: LiveBinding,
  index: number,
  merged: Record<string, unknown>,
  hash: string,
  ifStale: boolean,
  signal: AbortSignal | undefined,
  pinned: { definition: FunctionDefinition; revision: number } | undefined,
): Promise<BindingQueryResult> {
  const executed: LiveBinding = { ...binding, args: merged };
  const share: RefreshShareOptions = {
    bindingIds: [binding.id],
    coalesceNonCache: true,
    ...(ifStale ? { ifStale: true } : {}),
    ...(signal ? { signal } : {}),
  };
  const now = deps.now ?? (() => new Date().toISOString());
  const ttl = effectiveTtlSeconds(manifest.refresh);
  return coordinateRefresh(
    variantFlightKey(storageKey, binding.id, hash),
    share,
    () => executeVariant(db, deps, storageKey, executed, index, hash, argsHash(binding.args), ifStale, ttl, now, pinned),
    () => runVariant(db, deps, storageKey, manifest, binding, index, merged, hash, ifStale, signal, pinned),
    {
      onCapacity: () => capacityResult(db, storageKey, binding.id, hash),
      freshCache: () => {
        if (!ifStale) return undefined;
        const live = loadRow(db, storageKey);
        if (!live || live.deleted_at || !projectMatches(live.project_root_id, deps.projectRoot, deps.projectId)) return undefined;
        if (!isLiveKind(live.kind) || live.status === "expired") return undefined;
        const stored = snapshotRow(db, storageKey, binding.id, hash);
        if (!stored || snapshotNeedsRefresh(stored, now(), ttl)) return undefined;
        return cacheResult(binding.id, hash, stored);
      },
    },
  );
}

async function executeVariant(
  db: Database.Database,
  deps: ArtifactRefreshDeps,
  storageKey: string,
  binding: LiveBinding,
  index: number,
  hash: string,
  defaultHash: string,
  ifStale: boolean,
  ttl: number,
  now: () => string,
  pinned: { definition: FunctionDefinition; revision: number } | undefined,
): Promise<BindingQueryResult> {
  const row = assertLiveRow(loadRow(db, storageKey), deps.projectRoot, deps.projectId);
  const startedVersion = row.current_version;
  const nowIso = now();
  if (ifStale) {
    const stored = snapshotRow(db, storageKey, binding.id, hash);
    if (stored && !snapshotNeedsRefresh(stored, nowIso, ttl)) return cacheResult(binding.id, hash, stored);
  }
  const nowMs = Date.parse(nowIso);
  if (!tryAcquireVariant(storageKey, Number.isFinite(nowMs) ? nowMs : Date.now())) {
    return capacityResult(db, storageKey, binding.id, hash);
  }
  try {
    // Invocation history has no generic detail column (kind, code, and ids only).
    // The artifact key, binding id, and args hash are not stored, and neither are args or results.
    const outcome = await executeLiveBinding(
      db,
      deps.projectRoot,
      ownerOf(row),
      binding,
      index,
      deps.invoke ?? defaultInvoke(db),
      pinned,
    );
    return settleVariant(db, deps, storageKey, binding, hash, defaultHash, startedVersion, outcome);
  } finally {
    releaseVariant(storageKey);
  }
}

function settleVariant(
  db: Database.Database,
  deps: ArtifactRefreshDeps,
  storageKey: string,
  binding: LiveBinding,
  hash: string,
  defaultHash: string,
  startedVersion: number,
  outcome: { code?: string; valueJson?: string; duration?: number },
): BindingQueryResult {
  if (outcome.code || outcome.valueJson === undefined) {
    const previous = snapshotRow(db, storageKey, binding.id, hash);
    return finish({
      binding_id: binding.id,
      args_hash: hash,
      snapshot: previous ? snapshotView(previous, "cache") : null,
      errors: [{ binding_id: binding.id, code: outcome.code ?? "artifact.refresh_failed" }],
    });
  }
  const stored = storeVariant(
    db,
    deps,
    storageKey,
    binding.id,
    defaultHash,
    hash,
    outcome.valueJson,
    outcome.duration ?? 0,
    startedVersion,
  );
  if (stored === "missing") {
    throw new ArtifactQueryError(404, "artifact.not_found", "Artifact not found");
  }
  if (stored === "superseded") {
    return finish({
      binding_id: binding.id,
      args_hash: hash,
      snapshot: null,
      errors: [{ binding_id: binding.id, code: "artifact.refresh_failed" }],
    });
  }
  const row = snapshotRow(db, storageKey, binding.id, hash);
  if (!row) {
    return finish({
      binding_id: binding.id,
      args_hash: hash,
      snapshot: null,
      errors: [{ binding_id: binding.id, code: "artifact.refresh_failed" }],
    });
  }
  return {
    binding_id: binding.id,
    args_hash: hash,
    snapshot: snapshotView(row, "executed"),
    errors: [],
  };
}
