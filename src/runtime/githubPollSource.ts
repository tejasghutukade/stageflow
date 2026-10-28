import { Octokit } from "octokit";
import {
  listCatalogTriggerMatches,
  triggerStoreId,
  type CatalogTriggerMatch,
} from "../config/triggerCatalog.js";
import { readSecretFromEnvOrFile } from "../config/secretFromEnvOrFile.js";
import type { RunStore } from "../runstore/port.js";
import type { TaskFile } from "../types/task.js";
import type { TriggerFile } from "../types/trigger.js";
import { matchesEventFilter } from "./triggerEventMatch.js";
import type { TriggerFireEvent, TriggerSourcePort } from "./triggerPort.js";

export const DEFAULT_GITHUB_POLL_INTERVAL_MS = 60_000;
export const DEFAULT_GITHUB_TOKEN_SECRET = "GITHUB_TOKEN";

const GITHUB_REPO_RE = /^[^\s/]+\/[^\s/]+$/;

/** Parse `STAGEFLOW_GITHUB_POLL_INTERVAL_MS`; default 60s; `0` disables. */
export function githubPollIntervalMsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.STAGEFLOW_GITHUB_POLL_INTERVAL_MS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_GITHUB_POLL_INTERVAL_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_GITHUB_POLL_INTERVAL_MS;
  return parsed;
}

export type GithubPullItem = {
  number: number;
  title: string;
  html_url: string;
  state: string;
  merged_at: string | null;
  created_at: string;
  updated_at: string;
  user: { login: string } | null;
  head_sha?: string | null;
};

export type GithubPollResponse = {
  status: number;
  etag?: string;
  items: GithubPullItem[];
};

/**
 * Narrow, test-friendly seam over "list PR activity for a repo, conditionally
 * on an ETag". The default implementation adapts `octokit.rest.pulls.list`;
 * tests inject a fake so no real GitHub calls happen.
 */
export type GithubPollClient = {
  listPulls(params: {
    owner: string;
    repo: string;
    etag?: string;
  }): Promise<GithubPollResponse>;
};

export function defaultCreateGithubClient(token: string): GithubPollClient {
  const octokit = new Octokit({ auth: token });
  return {
    async listPulls({ owner, repo, etag }) {
      let response;
      try {
        response = await octokit.rest.pulls.list({
          owner,
          repo,
          state: "all",
          sort: "updated",
          direction: "desc",
          per_page: 30,
          ...(etag !== undefined ? { headers: { "If-None-Match": etag } } : {}),
        });
      } catch (err) {
        if (err !== null && typeof err === "object" && "status" in err && err.status === 304) {
          return { status: 304, items: [] };
        }
        throw err;
      }
      const responseEtag = response.headers.etag;
      return {
        status: response.status,
        ...(typeof responseEtag === "string" ? { etag: responseEtag } : {}),
        items: response.data.map((pr) => ({
          number: pr.number,
          title: pr.title,
          html_url: pr.html_url,
          state: pr.state,
          merged_at: pr.merged_at,
          created_at: pr.created_at,
          updated_at: pr.updated_at,
          user: pr.user ? { login: pr.user.login } : null,
          head_sha: pr.head?.sha ?? null,
        })),
      };
    },
  };
}

export type NormalizedGithubEvent = {
  action: "opened" | "synchronize" | "updated" | "merged" | "closed";
  number: number;
  title: string;
  url: string;
  author: string;
  repo: string;
  updatedAt: string;
  headSha?: string;
};

const HEADS_LIMIT = 200;

export function deriveGithubAction(
  item: GithubPullItem,
  previousHeadSha: string | undefined,
): NormalizedGithubEvent["action"] {
  if (item.merged_at) return "merged";
  if (item.state === "closed") return "closed";
  if (previousHeadSha === undefined) return "opened";
  if (item.created_at === item.updated_at) return "opened";
  const currentSha = item.head_sha ?? null;
  if (currentSha !== null && currentSha !== previousHeadSha) {
    return "synchronize";
  }
  return "updated";
}

function normalizeGithubItem(
  item: GithubPullItem,
  repo: string,
  previousHeadSha: string | undefined,
): NormalizedGithubEvent {
  const headSha = item.head_sha ?? null;
  return {
    action: deriveGithubAction(item, previousHeadSha),
    number: item.number,
    title: item.title,
    url: item.html_url,
    author: item.user?.login ?? "unknown",
    repo,
    updatedAt: item.updated_at,
    ...(headSha ? { headSha } : {}),
  };
}

function parseHeads(raw: string | null): Record<string, string> {
  if (raw === null) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string") out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function seedHeadsFromItems(items: GithubPullItem[]): Record<string, string> {
  const heads: Record<string, string> = {};
  for (const item of items) {
    const sha = item.head_sha ?? null;
    if (sha) heads[String(item.number)] = sha;
  }
  return heads;
}

function boundHeads(
  heads: Record<string, string>,
  currentItems: GithubPullItem[],
): Record<string, string> {
  if (Object.keys(heads).length <= HEADS_LIMIT) return heads;
  const currentNumbers = new Set(currentItems.map((item) => String(item.number)));
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(heads)) {
    if (currentNumbers.has(key)) next[key] = value;
  }
  return next;
}

type PollCursor = { updatedAt: string; number: number };

function parseCursor(raw: string | null): PollCursor | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PollCursor>;
    if (typeof parsed.updatedAt === "string" && typeof parsed.number === "number") {
      return { updatedAt: parsed.updatedAt, number: parsed.number };
    }
  } catch {
    // Corrupted/foreign value; treat as unset.
  }
  return null;
}

function isNewerThanCursor(item: GithubPullItem, cursor: PollCursor): boolean {
  const itemMs = new Date(item.updated_at).getTime();
  const cursorMs = new Date(cursor.updatedAt).getTime();
  if (itemMs !== cursorMs) return itemMs > cursorMs;
  return item.number > cursor.number;
}

function firstSecretRef(matches: Array<{ definition: TriggerFile }>): string | undefined {
  for (const { definition } of matches) {
    const secretRef = definition.event?.config?.secretRef;
    if (typeof secretRef === "string" && secretRef.length > 0) return secretRef;
  }
  return undefined;
}

export type GithubPollSourceOptions = {
  store: RunStore;
  cwd?: string;
  intervalMs?: number;
  logError?: (message: string) => void;
  env?: NodeJS.ProcessEnv;
  /** Injectable client factory so tests never hit real GitHub. */
  createGithubClient?: (token: string) => GithubPollClient;
};

/**
 * `TriggerSourcePort` adapter for `event`-kind triggers whose `event.source`
 * starts with `github.`. Ticks on an interval; each tick re-scans the catalog,
 * groups triggers by their distinct `event.config.repo` (one API call per repo
 * per tick regardless of how many triggers watch it), and diffs each repo's
 * PR list against a persisted ETag + cursor to find genuinely new activity.
 *
 * The first tick for a never-before-seen repo only seeds the cursor and
 * per-PR head SHAs — it never fires for a repo's pre-existing PR history,
 * mirroring how `ScheduleSource` seeds `next_run_at` without firing on
 * first sight.
 */
export class GithubPollSource implements TriggerSourcePort {
  private readonly store: RunStore;
  private readonly cwd: string;
  private readonly intervalMs: number;
  private readonly logError: (message: string) => void;
  private readonly env: NodeJS.ProcessEnv;
  private readonly createGithubClient: (token: string) => GithubPollClient;
  private interval: NodeJS.Timeout | undefined;
  private inFlight = false;

  constructor(options: GithubPollSourceOptions) {
    this.store = options.store;
    this.cwd = options.cwd ?? process.cwd();
    this.intervalMs = options.intervalMs ?? DEFAULT_GITHUB_POLL_INTERVAL_MS;
    this.logError =
      options.logError ??
      ((message: string) => {
        console.error(message);
      });
    this.env = options.env ?? process.env;
    this.createGithubClient = options.createGithubClient ?? defaultCreateGithubClient;
  }

  async start(onFire: (event: TriggerFireEvent) => Promise<void>): Promise<void> {
    if (this.intervalMs <= 0) return;
    this.interval = setInterval(() => {
      if (this.inFlight) return;
      this.inFlight = true;
      void this.tick(onFire)
        .catch((err) => {
          this.logError(
            `github poll tick failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        })
        .finally(() => {
          this.inFlight = false;
        });
    }, this.intervalMs).unref();
  }

  async stop(): Promise<void> {
    if (this.interval !== undefined) clearInterval(this.interval);
    this.interval = undefined;
  }

  /**
   * One discovery + poll + fire pass. Public so tests can drive it directly
   * instead of waiting on real interval timers.
   */
  async tick(onFire: (event: TriggerFireEvent) => Promise<void>): Promise<void> {
    const catalogTriggers = await listCatalogTriggerMatches({
      store: this.store,
      bootCwd: this.cwd,
      sourceRootsOnly: true,
    });
    const groups = this.discover(catalogTriggers);

    for (const [repo, matches] of groups) {
      for (const match of matches) {
        await this.store.upsertTrigger({
          id: triggerStoreId(match.project_root, match.definition.id),
          definitionRef: match.definition_ref,
          enabled: true,
        });
      }
      await this.pollRepo(repo, matches, onFire);
    }
  }

  private discover(
    catalogTriggers: CatalogTriggerMatch[],
  ): Map<string, CatalogTriggerMatch[]> {
    const groups = new Map<string, CatalogTriggerMatch[]>();
    for (const match of catalogTriggers) {
      const definition = match.definition;
      if (definition.kind !== "event" || !definition.enabled) continue;
      const source = definition.event?.source;
      if (typeof source !== "string" || !source.startsWith("github.")) continue;

      const repo = definition.event?.config?.repo;
      if (typeof repo !== "string" || !GITHUB_REPO_RE.test(repo)) {
        this.logError(
          `github poll: trigger "${definition.id}" has an invalid event.config.repo ` +
            `(expected "owner/repo"); skipping`,
        );
        continue;
      }

      const list = groups.get(repo) ?? [];
      list.push(match);
      groups.set(repo, list);
    }
    return groups;
  }

  private async pollRepo(
    repo: string,
    matches: CatalogTriggerMatch[],
    onFire: (event: TriggerFireEvent) => Promise<void>,
  ): Promise<void> {
    const secretRef = firstSecretRef(matches) ?? DEFAULT_GITHUB_TOKEN_SECRET;
    let token: string | undefined;
    try {
      token = readSecretFromEnvOrFile(this.env, secretRef);
    } catch (err) {
      this.logError(
        `github poll: failed to read secret "${secretRef}" for repo "${repo}": ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return;
    }
    if (token === undefined) {
      this.logError(
        `github poll: secret "${secretRef}" is not set for repo "${repo}"; skipping this tick`,
      );
      return;
    }

    const adapterId = `github:${repo}`;
    const etag = await this.store.getTriggerAdapterState(adapterId, "etag");
    const cursor = parseCursor(await this.store.getTriggerAdapterState(adapterId, "cursor"));
    let heads = parseHeads(await this.store.getTriggerAdapterState(adapterId, "heads"));

    const [owner, repoName] = repo.split("/");
    let response: GithubPollResponse;
    try {
      const client = this.createGithubClient(token);
      response = await client.listPulls({
        owner,
        repo: repoName,
        ...(etag !== null ? { etag } : {}),
      });
    } catch (err) {
      this.logError(
        `github poll: request failed for repo "${repo}": ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return;
    }

    if (response.status === 304) return;

    if (response.etag !== undefined) {
      await this.store.setTriggerAdapterState(adapterId, "etag", response.etag);
    }

    if (response.items.length === 0) return;

    const newest = response.items[0];

    if (cursor === null) {
      heads = seedHeadsFromItems(response.items);
      await this.store.setTriggerAdapterState(adapterId, "heads", JSON.stringify(heads));
      await this.store.setTriggerAdapterState(
        adapterId,
        "cursor",
        JSON.stringify({ updatedAt: newest.updated_at, number: newest.number }),
      );
      return;
    }

    const newItems = response.items.filter((item) => isNewerThanCursor(item, cursor)).reverse();

    for (const item of newItems) {
      const numberKey = String(item.number);
      const previousHeadSha =
        Object.prototype.hasOwnProperty.call(heads, numberKey) ? heads[numberKey] : undefined;
      const summary = normalizeGithubItem(item, repo, previousHeadSha);
      heads[numberKey] = item.head_sha ?? previousHeadSha ?? "";
      for (const match of matches) {
        const { definition } = match;
        if (!matchesEventFilter(definition.event?.match, summary as unknown as Record<string, unknown>)) continue;
        await this.fireSafely(onFire, match, summary);
      }
    }

    heads = boundHeads(heads, response.items);
    await this.store.setTriggerAdapterState(adapterId, "heads", JSON.stringify(heads));
    await this.store.setTriggerAdapterState(
      adapterId,
      "cursor",
      JSON.stringify({ updatedAt: newest.updated_at, number: newest.number }),
    );
  }

  private async fireSafely(
    onFire: (event: TriggerFireEvent) => Promise<void>,
    match: CatalogTriggerMatch,
    summary: NormalizedGithubEvent,
  ): Promise<void> {
    const definition = match.definition;
    try {
      if (definition.task !== undefined) {
        await onFire({ triggerId: definition.id, project_root: match.project_root });
        return;
      }
      const task: TaskFile = {
        id: `${definition.id}-pr-${summary.number}`,
        goal: `Handle PR #${summary.number}: ${summary.title}`,
        input: summary as unknown as Record<string, unknown>,
      };
      await onFire({ triggerId: definition.id, project_root: match.project_root, task });
    } catch (err) {
      this.logError(
        `github poll: firing trigger "${definition.id}" failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
