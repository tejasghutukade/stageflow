import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import type Database from "better-sqlite3";
import { scrubSecrets, SECRET_KEY_RE } from "../compaction/scrub.js";
import { payloadInstanceMismatch } from "../envelope/payloadSchema.js";
import type { FunctionDefinition } from "../config/loadFunction.js";
import type { FunctionCallInput, FunctionRunView } from "../functions/invoke.js";
import { createFunctionInvoker } from "../functions/invoke.js";
import { FunctionError } from "../functions/service.js";
import { FunctionService } from "../functions/service.js";
import { FunctionStore } from "../functions/store.js";
import { checkBinding } from "./bindings.js";
import { expiredContentMessage } from "./content.js";
import { LIVE_SNAPSHOT_MAX_BYTES, ArtifactPublishError } from "./limits.js";
import { argsHash, parseStoredLiveManifest, type LiveBinding, type LiveManifest } from "./manifest.js";
import { ArtifactQueryError } from "./query.js";
import type { ArtifactOwner } from "./record.js";
import { isLiveDeclarativeKind } from "./kinds.js";
import {
  effectiveTtlSeconds,
  REFRESH_RETRY_AFTER_SECONDS,
  snapshotNeedsRefresh,
  type ArtifactSnapshotSource,
} from "./refreshPolicy.js";
import { coordinateRefresh, refreshInFlightCount, type RefreshShareOptions } from "./refreshShare.js";

export type ArtifactRefreshDeps = {
  projectRoot: string;
  now?: () => string;
  /** Defaults to the Host function invoker. Tests pass a spy. Eligibility failures do not call it. */
  invoke?: (projectRoot: string, input: FunctionCallInput) => Promise<FunctionRunView>;
};

export type ArtifactSnapshotView = {
  binding_id: string;
  args_hash: string;
  value: unknown;
  fetched_at: string;
  duration_ms: number;
  status: string;
  error_code: string | null;
  source?: ArtifactSnapshotSource;
};

export type ArtifactRefreshResult = {
  status: string | null;
  snapshots: ArtifactSnapshotView[];
  last_refreshed_at: string | null;
  last_error_code: string | null;
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

/**
 * Per-key lock order is the publish lock, then this refresh lock.
 * Publish holds only the publish lock, so a new version can commit while a refresh
 * is running the function. The snapshot write then sees the new version and discards
 * its result. Delete holds the publish lock and then this lock. The refresh lock is
 * reentrant for the same key, so a delete started from inside that refresh runs at
 * once and the snapshot write sees the artifact is gone.
 *
 * At most 32 refresh executions wait behind the one that is running. The next
 * caller that needs its own execution is refused with artifact.resource_limit
 * and the last stored snapshots. Callers that only join an in-flight execution,
 * and ifStale callers that reuse a fresh snapshot, do not take one of those slots.
 * Mutate callers (delete) queue ahead of refresh callers that are waiting on this
 * lock. They are not subject to the cap. Aborting a joined caller does not cancel
 * the shared execution.
 */
const refreshHeld = new AsyncLocalStorage<Set<string>>();
const refreshQueues = new Map<string, Array<{ kind: RefreshLockKind; run: () => Promise<void> }>>();
const refreshRunning = new Map<string, RefreshLockKind>();
const refreshLeadersPending = new Map<string, number>();

export const REFRESH_QUEUE_WAITING = 32;
export const SNAPSHOT_MAX_DEPTH = 64;
export const SNAPSHOT_MAX_NODES = 200_000;
export const REFRESH_RECOVERY_STALE_MS = 10 * 60 * 1000;

export type RefreshLockKind = "refresh" | "mutate";

function bumpCount(map: Map<string, number>, key: string, delta: number): void {
  const next = (map.get(key) ?? 0) + delta;
  if (next <= 0) map.delete(key);
  else map.set(key, next);
}

function refreshExecutionCount(key: string): number {
  let count = refreshRunning.get(key) === "refresh" ? 1 : 0;
  count += (refreshQueues.get(key) ?? []).filter((job) => job.kind === "refresh").length;
  count += refreshLeadersPending.get(key) ?? 0;
  return count;
}

export function tryBeginRefreshLeader(key: string): boolean {
  if (refreshExecutionCount(key) > REFRESH_QUEUE_WAITING) return false;
  bumpCount(refreshLeadersPending, key, 1);
  return true;
}

export function refreshLeaderEntered(key: string): void {
  bumpCount(refreshLeadersPending, key, -1);
}

export function refreshShareIdle(): boolean {
  return (
    refreshInFlightCount() === 0 &&
    refreshLeadersPending.size === 0 &&
    refreshRunning.size === 0 &&
    refreshQueues.size === 0
  );
}

function pumpRefreshLock(key: string): void {
  if (refreshRunning.has(key)) return;
  const queue = refreshQueues.get(key);
  if (!queue || queue.length === 0) {
    refreshQueues.delete(key);
    return;
  }
  const job = queue.shift()!;
  if (queue.length === 0) refreshQueues.delete(key);
  refreshRunning.set(key, job.kind);
  const nextHeld = new Set(refreshHeld.getStore());
  nextHeld.add(key);
  void refreshHeld
    .run(nextHeld, job.run)
    .finally(() => {
      refreshRunning.delete(key);
      pumpRefreshLock(key);
    });
}

export function refreshLockHeld(key: string): boolean {
  return refreshRunning.has(key) || (refreshQueues.get(key)?.length ?? 0) > 0;
}

export function withRefreshLock<T>(
  key: string,
  fn: () => Promise<T>,
  kind: RefreshLockKind = "refresh",
): Promise<T> {
  const held = refreshHeld.getStore();
  if (held?.has(key)) return fn();
  return new Promise<T>((resolve, reject) => {
    const job = {
      kind,
      run: async () => {
        try {
          resolve(await fn());
        } catch (error) {
          reject(error);
        }
      },
    };
    let queue = refreshQueues.get(key);
    if (!queue) {
      queue = [];
      refreshQueues.set(key, queue);
    }
    if (kind === "mutate") {
      const nextRefresh = queue.findIndex((entry) => entry.kind === "refresh");
      if (nextRefresh === -1) queue.push(job);
      else queue.splice(nextRefresh, 0, job);
    } else {
      queue.push(job);
    }
    pumpRefreshLock(key);
  });
}

function ownerOf(row: ArtifactLiveRow): ArtifactOwner {
  if (row.owner_kind === "agent") return { kind: "agent", agent: row.owner_agent ?? "" };
  return { kind: "stage", pipeline: row.owner_pipeline ?? "", stage: row.owner_stage ?? "" };
}

function projectMatches(stored: string, projectRoot: string): boolean {
  if (stored === projectRoot) return true;
  return path.resolve(stored) === path.resolve(projectRoot);
}

function jsonByteUpperBound(value: unknown): number {
  if (value === null) return 4;
  if (typeof value === "boolean") return value ? 4 : 5;
  if (typeof value === "number") return 24;
  if (typeof value === "string") return Buffer.byteLength(value, "utf8") * 2 + 2;
  if (Array.isArray(value)) {
    let total = 2;
    for (let index = 0; index < value.length; index += 1) {
      if (index > 0) total += 1;
      total += jsonByteUpperBound(value[index]);
    }
    return total;
  }
  if (typeof value === "object") {
    let total = 2;
    let first = true;
    for (const key of Object.keys(value as Record<string, unknown>)) {
      if (!first) total += 1;
      first = false;
      total += Buffer.byteLength(JSON.stringify(key), "utf8") + 1;
      total += jsonByteUpperBound((value as Record<string, unknown>)[key]);
    }
    return total;
  }
  return 4;
}

export function snapshotSerializedTooLarge(value: unknown): boolean {
  if (typeof value === "string") return value.length + 2 > LIVE_SNAPSHOT_MAX_BYTES;
  const limit = snapshotShapeLimit(value);
  if (limit !== null) return limit === "nodes";
  return jsonByteUpperBound(value) > LIVE_SNAPSHOT_MAX_BYTES;
}

export function snapshotShapeLimit(value: unknown): "depth" | "nodes" | null {
  let nodes = 0;
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 1 }];
  while (stack.length > 0) {
    const item = stack.pop()!;
    nodes += 1;
    if (nodes > SNAPSHOT_MAX_NODES) return "nodes";
    if (item.depth > SNAPSHOT_MAX_DEPTH) return "depth";
    if (Array.isArray(item.value)) {
      if (item.value.length > 0 && item.depth + 1 > SNAPSHOT_MAX_DEPTH) return "depth";
      if (nodes + item.value.length > SNAPSHOT_MAX_NODES) return "nodes";
      for (let index = item.value.length - 1; index >= 0; index -= 1) {
        const child = item.value[index];
        if (child !== null && typeof child === "object") stack.push({ value: child, depth: item.depth + 1 });
        else nodes += 1;
      }
      continue;
    }
    if (item.value !== null && typeof item.value === "object") {
      const children = Object.values(item.value as Record<string, unknown>);
      if (children.length > 0 && item.depth + 1 > SNAPSHOT_MAX_DEPTH) return "depth";
      if (nodes + children.length > SNAPSHOT_MAX_NODES) return "nodes";
      for (let index = children.length - 1; index >= 0; index -= 1) {
        const child = children[index];
        if (child !== null && typeof child === "object") stack.push({ value: child, depth: item.depth + 1 });
        else nodes += 1;
      }
    }
  }
  return null;
}

export function scrubSnapshotValue(value: unknown): unknown {
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return scrubSecrets(value);
  if (Array.isArray(value)) return value.map((entry) => scrubSnapshotValue(entry));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY_RE.test(key) ? "[redacted]" : scrubSnapshotValue(child);
    }
    return out;
  }
  return null;
}

function viewOf(row: SnapshotRow): ArtifactSnapshotView {
  let value: unknown = null;
  if (row.value_json) {
    try {
      value = JSON.parse(row.value_json) as unknown;
    } catch {
      value = null;
    }
  }
  return {
    binding_id: row.binding_id,
    args_hash: row.args_hash,
    value,
    fetched_at: row.fetched_at,
    duration_ms: row.duration_ms,
    status: row.status,
    error_code: row.error_code,
  };
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

function snapshotRows(db: Database.Database, key: string): SnapshotRow[] {
  return db
    .prepare(
      `SELECT binding_id, args_hash, value_json, fetched_at, duration_ms, status, error_code
         FROM artifact_snapshots
        WHERE artifact_key = ?
        ORDER BY binding_id, args_hash`,
    )
    .all(key) as SnapshotRow[];
}

function pairKey(bindingId: string, hash: string): string {
  return `${bindingId}\0${hash}`;
}

function currentSnapshots(rows: SnapshotRow[], bindings: readonly LiveBinding[]): ArtifactSnapshotView[] {
  const wanted = new Set(bindings.map((binding) => pairKey(binding.id, argsHash(binding.args))));
  return rows.filter((row) => wanted.has(pairKey(row.binding_id, row.args_hash))).map(viewOf);
}

function successfulSnapshots(rows: SnapshotRow[], bindings: readonly LiveBinding[]): SnapshotRow[] {
  const wanted = new Set(bindings.map((binding) => pairKey(binding.id, argsHash(binding.args))));
  return rows.filter((row) => row.status === "ok" && wanted.has(pairKey(row.binding_id, row.args_hash)));
}

function newestFetched(rows: readonly SnapshotRow[]): string | null {
  let newest: string | null = null;
  for (const row of rows) {
    if (newest === null || row.fetched_at > newest) newest = row.fetched_at;
  }
  return newest;
}

export function liveRefreshState(
  rows: readonly SnapshotRow[],
  bindings: readonly LiveBinding[],
  failed = false,
): { status: "fresh" | "stale" | "error"; last_refreshed_at: string | null } {
  const ok = successfulSnapshots([...rows], bindings);
  if (!failed && bindings.length > 0 && ok.length === bindings.length) {
    return { status: "fresh", last_refreshed_at: newestFetched(ok) };
  }
  if (ok.length > 0) return { status: "stale", last_refreshed_at: newestFetched(ok) };
  return { status: "error", last_refreshed_at: null };
}

function assertLiveRow(row: ArtifactLiveRow | undefined, projectRoot: string): ArtifactLiveRow {
  if (!row || row.deleted_at || !projectMatches(row.project_root_id, projectRoot)) {
    throw new ArtifactQueryError(404, "artifact.not_found", "Artifact not found");
  }
  if (!isLiveDeclarativeKind(row.kind)) {
    throw new ArtifactQueryError(404, "artifact.not_live", "Artifact is not live");
  }
  if (row.status === "expired") {
    throw new ArtifactQueryError(404, "artifact.content_unavailable", expiredContentMessage(row.expired_reason));
  }
  return row;
}

export function readArtifactSnapshots(db: Database.Database, key: string, projectRoot?: string): ArtifactRefreshResult {
  const row = loadRow(db, key);
  if (!row || row.deleted_at || (projectRoot !== undefined && !projectMatches(row.project_root_id, projectRoot))) {
    throw new ArtifactQueryError(404, "artifact.not_found", "Artifact not found");
  }
  if (!isLiveDeclarativeKind(row.kind)) {
    throw new ArtifactQueryError(404, "artifact.not_live", "Artifact is not live");
  }
  if (row.status === "expired") {
    throw new ArtifactQueryError(404, "artifact.content_unavailable", expiredContentMessage(row.expired_reason));
  }
  const manifest = parseStoredLiveManifest(row.manifest_json);
  const bindings = manifest?.bindings ?? [];
  return {
    status: row.live_status,
    snapshots: currentSnapshots(snapshotRows(db, key), bindings),
    last_refreshed_at: row.last_refreshed_at,
    last_error_code: row.last_error_code,
    errors: [],
  };
}

function defaultInvoke(db: Database.Database): NonNullable<ArtifactRefreshDeps["invoke"]> {
  const invoker = createFunctionInvoker({ db });
  return (projectRoot, input) => invoker.call(projectRoot, input);
}

function errorCode(view: FunctionRunView): string {
  if (view.code === "resource_limit") return "artifact.resource_limit";
  if (view.code && view.code.length > 0) return view.code;
  return "artifact.refresh_failed";
}

export async function loadPinnedFunction(
  db: Database.Database,
  projectRoot: string,
  functionId: string,
): Promise<{ definition: FunctionDefinition; revision: number } | undefined> {
  const service = new FunctionService({ store: new FunctionStore(db) });
  try {
    const detail = await service.get(projectRoot, functionId);
    if (!detail.definition || detail.revision <= 0) return undefined;
    return { definition: detail.definition, revision: detail.revision };
  } catch {
    return undefined;
  }
}

export type ArtifactRefreshOptions = RefreshShareOptions;

function capacityRefreshResult(
  db: Database.Database,
  deps: ArtifactRefreshDeps,
  key: string,
  options: ArtifactRefreshOptions,
): ArtifactRefreshResult {
  const row = assertLiveRow(loadRow(db, key), deps.projectRoot);
  const manifest = parseStoredLiveManifest(row.manifest_json);
  const bindings = manifest?.bindings ?? [];
  const selected = manifest ? [...selectBindings(manifest, options.bindingIds, options.bindingIdsIssuePath ?? "bindingIds")] : [];
  for (const id of options.skipBindingIds ?? []) {
    const index = selected.indexOf(id);
    if (index >= 0) selected.splice(index, 1);
  }
  const bindingIds = selected.length > 0 ? selected : ["artifact"];
  const snapshots = currentSnapshots(snapshotRows(db, key), bindings).map((snapshot) => ({
    ...snapshot,
    source: "cache" as const,
  }));
  const ok = snapshots.some((snapshot) => snapshot.status === "ok");
  return finishRefreshResult({
    status: ok ? "stale" : "error",
    snapshots,
    last_refreshed_at: ok ? row.last_refreshed_at : null,
    last_error_code: "artifact.resource_limit",
    errors: bindingIds.map((bindingId) => ({ binding_id: bindingId, code: "artifact.resource_limit" })),
  });
}

function freshIfStaleResult(
  db: Database.Database,
  deps: ArtifactRefreshDeps,
  key: string,
  options: ArtifactRefreshOptions,
): ArtifactRefreshResult | undefined {
  if (options.ifStale !== true) return undefined;
  const row = loadRow(db, key);
  if (!row || row.deleted_at || !projectMatches(row.project_root_id, deps.projectRoot)) return undefined;
  if (!isLiveDeclarativeKind(row.kind) || row.status === "expired") return undefined;
  const manifest = parseStoredLiveManifest(row.manifest_json);
  if (!manifest) return undefined;
  let selected: Set<string>;
  try {
    selected = selectBindings(manifest, options.bindingIds, options.bindingIdsIssuePath ?? "bindingIds");
  } catch {
    return undefined;
  }
  for (const id of options.skipBindingIds ?? []) selected.delete(id);
  const existingRows = snapshotRows(db, key);
  const nowIso = (deps.now ?? (() => new Date().toISOString()))();
  const ttl = effectiveTtlSeconds(manifest.refresh);
  const sources = new Map<string, ArtifactSnapshotSource>();
  for (const binding of manifest.bindings) {
    if (!selected.has(binding.id)) continue;
    if (snapshotNeedsRefresh(snapshotFor(existingRows, binding), nowIso, ttl)) return undefined;
    sources.set(binding.id, "cache");
  }
  if (selected.size > 0 && sources.size !== selected.size) return undefined;
  return {
    status: row.live_status,
    snapshots: annotateSnapshots(currentSnapshots(existingRows, manifest.bindings), sources),
    last_refreshed_at: row.last_refreshed_at,
    last_error_code: row.last_error_code,
    errors: [],
  };
}

export async function refreshArtifact(
  db: Database.Database,
  deps: ArtifactRefreshDeps,
  key: string,
  options: ArtifactRefreshOptions = {},
): Promise<ArtifactRefreshResult> {
  return coordinateRefresh(
    key,
    options,
    () => withRefreshLock(key, () => refreshLocked(db, deps, key, options)),
    (next) => refreshArtifact(db, deps, key, next),
    {
      onCapacity: () => capacityRefreshResult(db, deps, key, options),
      freshCache: () => freshIfStaleResult(db, deps, key, options),
    },
  );
}

function forceTerminal(db: Database.Database, key: string): void {
  const row = loadRow(db, key);
  if (!row || row.deleted_at || row.live_status !== "refreshing") return;
  const manifest = parseStoredLiveManifest(row.manifest_json);
  const bindings = manifest?.bindings ?? [];
  const state = liveRefreshState(snapshotRows(db, key), bindings);
  const status = state.status === "fresh" ? "stale" : state.status;
  db.prepare(
    `UPDATE artifacts
        SET live_status = @status,
            last_error_code = COALESCE(last_error_code, 'artifact.refresh_failed')
      WHERE key = @key AND live_status = 'refreshing' AND deleted_at IS NULL`,
  ).run({ key, status });
}

export type RecoverRefreshingScope = "startup" | "sweep";

export function recoverRefreshingArtifacts(
  db: Database.Database,
  scope: RecoverRefreshingScope = "startup",
  nowMs: number = Date.now(),
): number {
  const columns = db.prepare(`PRAGMA table_info(artifacts)`).all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "live_status")) return 0;
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'artifact_snapshots'`).get();
  if (!tables) return 0;
  const staleSql = `UPDATE artifacts
          SET live_status = CASE
                WHEN EXISTS (
                  SELECT 1 FROM artifact_snapshots s
                   WHERE s.artifact_key = artifacts.key AND s.status = 'ok'
                ) THEN 'stale'
                ELSE 'error'
              END,
              last_error_code = 'artifact.refresh_failed'
        WHERE live_status = 'refreshing' AND deleted_at IS NULL`;
  if (scope === "startup") {
    return db.prepare(staleSql).run().changes;
  }
  const heldKeys = [...new Set([...refreshRunning.keys(), ...refreshQueues.keys()])];
  const staleBefore = new Date(nowMs - REFRESH_RECOVERY_STALE_MS).toISOString();
  const sweepSql = `${staleSql} AND updated_at < ?${
    heldKeys.length > 0 ? ` AND key NOT IN (${heldKeys.map(() => "?").join(", ")})` : ""
  }`;
  return db.prepare(sweepSql).run(staleBefore, ...heldKeys).changes;
}

function snapshotFor(rows: readonly SnapshotRow[], binding: LiveBinding): SnapshotRow | undefined {
  const hash = argsHash(binding.args);
  return rows.find((row) => row.binding_id === binding.id && row.args_hash === hash);
}

function annotateSnapshots(
  snapshots: ArtifactSnapshotView[],
  sources: ReadonlyMap<string, ArtifactSnapshotSource>,
): ArtifactSnapshotView[] {
  return snapshots.map((snapshot) => {
    const source = sources.get(snapshot.binding_id);
    return source === undefined ? snapshot : { ...snapshot, source };
  });
}

function finishRefreshResult(result: ArtifactRefreshResult): ArtifactRefreshResult {
  if (result.errors.some((error) => error.code === "artifact.resource_limit")) {
    result.retry_after_seconds = REFRESH_RETRY_AFTER_SECONDS;
  }
  return result;
}

async function refreshLocked(
  db: Database.Database,
  deps: ArtifactRefreshDeps,
  key: string,
  options: ArtifactRefreshOptions,
): Promise<ArtifactRefreshResult> {
  let markedRefreshing = false;
  try {
    const row = assertLiveRow(loadRow(db, key), deps.projectRoot);
    const manifest = parseStoredLiveManifest(row.manifest_json);
    if (!manifest) {
      throw new ArtifactPublishError(400, "artifact.invalid_shape", "Live artifact manifest is not valid", [
        { path: "manifest", message: "Live artifact manifest is not valid" },
      ]);
    }
    const bindingIdsPath = options.bindingIdsIssuePath ?? "bindingIds";
    const selected = selectBindings(manifest, options.bindingIds, bindingIdsPath);
    for (const id of options.skipBindingIds ?? []) selected.delete(id);
    const invoke = deps.invoke ?? defaultInvoke(db);
    const now = deps.now ?? (() => new Date().toISOString());
    const owner = ownerOf(row);
    const startedVersion = row.current_version;
    const sources = new Map<string, ArtifactSnapshotSource>();
    const runnable = new Set<string>();
    const nowIso = now();
    const ttl = effectiveTtlSeconds(manifest.refresh);
    const existingRows = snapshotRows(db, key);
    for (const binding of manifest.bindings) {
      if (!selected.has(binding.id)) continue;
      if (options.ifStale === true && !snapshotNeedsRefresh(snapshotFor(existingRows, binding), nowIso, ttl)) {
        sources.set(binding.id, "cache");
        continue;
      }
      sources.set(binding.id, "executed");
      runnable.add(binding.id);
    }
    if (runnable.size === 0) {
      return finishRefreshResult({
        status: row.live_status,
        snapshots: annotateSnapshots(currentSnapshots(existingRows, manifest.bindings), sources),
        last_refreshed_at: row.last_refreshed_at,
        last_error_code: row.last_error_code,
        errors: [],
      });
    }
    db.prepare(
      `UPDATE artifacts SET live_status = 'refreshing', last_error_code = NULL, updated_at = ? WHERE key = ?`,
    ).run(nowIso, key);
    markedRefreshing = true;

    const errors: Array<{ binding_id: string; code: string }> = [];
    const ready: Array<{ binding: LiveBinding; valueJson: string; duration: number }> = [];
    for (let index = 0; index < manifest.bindings.length; index += 1) {
      const binding = manifest.bindings[index]!;
      if (!runnable.has(binding.id)) continue;
      const outcome = await executeLiveBinding(db, deps.projectRoot, owner, binding, index, invoke);
      if (outcome.code) errors.push({ binding_id: binding.id, code: outcome.code });
      else if (outcome.valueJson !== undefined) {
        ready.push({ binding, valueJson: outcome.valueJson, duration: outcome.duration ?? 0 });
      }
    }
    const produced = new Set(ready.map((item) => item.binding.id));
    for (const bindingId of runnable) {
      if (!produced.has(bindingId)) sources.set(bindingId, "cache");
    }

    const stored = db.transaction(() => {
      const current = loadRow(db, key);
      if (!current || current.deleted_at || !projectMatches(current.project_root_id, deps.projectRoot)) {
        return { kind: "missing" as const };
      }
      if (current.current_version !== startedVersion) return { kind: "superseded" as const };
      const fetchedAt = now();
      for (const item of ready) {
        const hash = argsHash(item.binding.args);
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
          binding_id: item.binding.id,
          args_hash: hash,
          value_json: item.valueJson,
          fetched_at: fetchedAt,
          duration_ms: Math.max(0, Math.round(item.duration)),
        });
      }

      const snapshots = snapshotRows(db, key);
      const state = liveRefreshState(snapshots, manifest.bindings, errors.length > 0);
      const lastError = errors[0]?.code ?? null;
      db.prepare(
        `UPDATE artifacts
            SET live_status = @status,
                last_refreshed_at = @last_refreshed_at,
                last_error_code = @last_error_code
          WHERE key = @key AND current_version = @version AND deleted_at IS NULL`,
      ).run({
        key,
        version: startedVersion,
        status: state.status,
        last_refreshed_at: state.last_refreshed_at,
        last_error_code: lastError,
      });
      return {
        kind: "stored" as const,
        result: {
          status: state.status,
          snapshots: annotateSnapshots(currentSnapshots(snapshotRows(db, key), manifest.bindings), sources),
          last_refreshed_at: state.last_refreshed_at,
          last_error_code: lastError,
          errors,
        },
      };
    }).immediate();
    markedRefreshing = false;
    if (stored.kind === "missing") {
      throw new ArtifactQueryError(404, "artifact.not_found", "Artifact not found");
    }
    if (stored.kind === "superseded") return readArtifactSnapshots(db, key, deps.projectRoot);
    return finishRefreshResult(stored.result);
  } finally {
    if (markedRefreshing) {
      try {
        forceTerminal(db, key);
      } catch {
        // The original failure is the one the caller sees.
      }
    }
  }
}

function selectBindings(
  manifest: LiveManifest,
  bindingIds: readonly string[] | undefined,
  issuePath = "bindingIds",
): Set<string> {
  if (bindingIds !== undefined && bindingIds.length === 0) {
    throw new ArtifactPublishError(400, "artifact.invalid_shape", `${issuePath} must list at least one binding`, [
      { path: issuePath, message: `${issuePath} must list at least one binding` },
    ]);
  }
  if (bindingIds === undefined) return new Set(manifest.bindings.map((binding) => binding.id));
  const known = new Set(manifest.bindings.map((binding) => binding.id));
  const issues = bindingIds
    .filter((id) => !known.has(id))
    .map((id) => ({ path: issuePath, message: `Unknown binding ${id}` }));
  if (issues.length > 0) {
    throw new ArtifactPublishError(400, "artifact.invalid_shape", "Unknown binding id", issues);
  }
  return new Set(bindingIds);
}

function outputFailure(definition: FunctionDefinition, value: unknown): string | undefined {
  if (!definition.output_schema) return undefined;
  try {
    const mismatch = payloadInstanceMismatch(value, definition.output_schema);
    return mismatch ? "invalid_output" : undefined;
  } catch {
    return "invalid_output";
  }
}

export async function executeLiveBinding(
  db: Database.Database,
  projectRoot: string,
  owner: ArtifactOwner,
  binding: LiveBinding,
  index: number,
  invoke: NonNullable<ArtifactRefreshDeps["invoke"]>,
  pinned?: { definition: FunctionDefinition; revision: number },
): Promise<{ code?: string; valueJson?: string; duration?: number }> {
  try {
    const loaded = pinned ?? (await loadPinnedFunction(db, projectRoot, binding.function));
    const checked = await checkBinding(projectRoot, owner, binding, index, loaded?.definition);
    if (checked.failure) return { code: checked.failure.code };
    if (!loaded) return { code: "artifact.function_changed" };
    const started = Date.now();
    let view: FunctionRunView;
    try {
      view = await invoke(projectRoot, {
        functionId: binding.function,
        kind: "tool",
        revision: loaded.revision,
        input: { kind: "tool", input: binding.args, envelope: null },
        historyKind: "artifact",
        grants: checked.grants,
      });
    } catch (error) {
      if (error instanceof FunctionError && error.code === "function.revision_not_found") {
        return { code: "artifact.function_changed" };
      }
      return { code: "artifact.refresh_failed" };
    }
    const duration = view.durationMs > 0 ? view.durationMs : Date.now() - started;
    if (!view.ok) return { code: errorCode(view) };
    if (outputFailure(loaded.definition, view.value ?? null)) return { code: "invalid_output" };
    const limit = snapshotShapeLimit(view.value ?? null);
    if (limit === "depth") return { code: "artifact.refresh_failed" };
    if (limit === "nodes" || snapshotSerializedTooLarge(view.value ?? null)) {
      return { code: "artifact.snapshot_too_large" };
    }
    const value = scrubSnapshotValue(view.value ?? null);
    const valueJson = JSON.stringify(value);
    if (Buffer.byteLength(valueJson, "utf8") > LIVE_SNAPSHOT_MAX_BYTES) return { code: "artifact.snapshot_too_large" };
    return { valueJson, duration };
  } catch {
    return { code: "artifact.refresh_failed" };
  }
}

export function reconcileLiveSnapshots(
  db: Database.Database,
  key: string,
  manifest: LiveManifest | null,
): void {
  if (!manifest) {
    db.prepare(`DELETE FROM artifact_snapshots WHERE artifact_key = ?`).run(key);
    db.prepare(
      `UPDATE artifacts
          SET live_status = NULL, last_error_code = NULL, last_refreshed_at = NULL
        WHERE key = ?`,
    ).run(key);
    return;
  }
  const keep = new Set(manifest.bindings.map((binding) => pairKey(binding.id, argsHash(binding.args))));
  const rows = snapshotRows(db, key);
  for (const row of rows) {
    if (keep.has(pairKey(row.binding_id, row.args_hash))) continue;
    db.prepare(
      `DELETE FROM artifact_snapshots WHERE artifact_key = ? AND binding_id = ? AND args_hash = ?`,
    ).run(key, row.binding_id, row.args_hash);
  }
  const remaining = successfulSnapshots(snapshotRows(db, key), manifest.bindings);
  if (remaining.length === 0) {
    db.prepare(
      `UPDATE artifacts
          SET live_status = NULL, last_error_code = NULL, last_refreshed_at = NULL
        WHERE key = ?`,
    ).run(key);
    return;
  }
  const state = liveRefreshState(snapshotRows(db, key), manifest.bindings);
  db.prepare(
    `UPDATE artifacts
        SET live_status = @status,
            last_error_code = NULL,
            last_refreshed_at = @last_refreshed_at
      WHERE key = @key`,
  ).run({ key, status: state.status, last_refreshed_at: state.last_refreshed_at });
}
