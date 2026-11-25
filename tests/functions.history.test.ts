import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  FUNCTION_HISTORY_DAYS_ENV,
  FUNCTION_HISTORY_MAX_ROWS_ENV,
  FUNCTION_INVOCATION_LIST_DEFAULT,
  functionHistoryLimits,
  listFunctionInvocations,
  pruneFunctionInvocations,
} from "../src/functions/history.js";
import { createFunctionInvoker } from "../src/functions/invoke.js";
import { FunctionService } from "../src/functions/service.js";
import { agentProjectKey, FunctionStore } from "../src/functions/store.js";
import { createRunStoreWithConnection } from "../src/runstore/createStore.js";
import { handleFunctionRoutes } from "../src/server/functionRoutes.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function insert(
  db: ReturnType<typeof createRunStoreWithConnection>["connection"],
  projectKey: string,
  id: string,
  createdAt: string,
): void {
  db.prepare(
    `INSERT INTO function_invocations (
       id, project_key, function_id, revision, source_hash, kind, status, duration_ms, code,
       attachment_id, run_id, stage_id, attempt, session_id, created_at
     ) VALUES (
       @id, @project_key, 'score', 1, 'hash', 'tool', 'succeeded', 1, NULL,
       NULL, NULL, NULL, NULL, NULL, @created_at
     )`,
  ).run({ id, project_key: projectKey, created_at: createdAt });
}

async function open() {
  const home = await mkdtemp(path.join(tmpdir(), "sf-fn-history-"));
  const project = await mkdtemp(path.join(tmpdir(), "sf-fn-history-proj-"));
  dirs.push(home, project);
  const { connection } = createRunStoreWithConnection({ rootDir: home, openerMode: "migrate" });
  const projectKey = agentProjectKey(project);
  return { connection, project, projectKey };
}

describe("function invocation history", () => {
  it("lists the newest rows and caps the REST limit", async () => {
    const { connection, project, projectKey } = await open();
    insert(connection, projectKey, "old", "2026-01-01T00:00:00.000Z");
    insert(connection, projectKey, "mid", "2026-01-02T00:00:00.000Z");
    insert(connection, projectKey, "new", "2026-01-03T00:00:00.000Z");
    expect(listFunctionInvocations(connection, projectKey, "score").map((row) => row.id)).toEqual(["new", "mid", "old"]);
    expect(listFunctionInvocations(connection, projectKey, "score", 2).map((row) => row.id)).toEqual(["new", "mid"]);
    expect(FUNCTION_INVOCATION_LIST_DEFAULT).toBe(200);

    const service = new FunctionService({ store: new FunctionStore(connection) });
    const invoker = createFunctionInvoker({ db: connection, stageflowHome: path.dirname(project) });
    const call = async (url: string) => {
      const sent: { status?: number; body?: { invocations?: Array<{ id: string }>; code?: string } } = {};
      const req = Object.assign(Readable.from([]), { method: "GET", url, headers: {} }) as IncomingMessage;
      const res = { headersSent: false, writableEnded: false, end() {} } as ServerResponse;
      await handleFunctionRoutes(req, "GET", "/api/functions/score/invocations", service, project, res, (_res, status, body) => {
        sent.status = status;
        sent.body = body as typeof sent.body;
      }, invoker);
      return sent;
    };
    const page = await call("/api/functions/score/invocations?limit=1");
    expect(page.status).toBe(200);
    expect(page.body?.invocations?.map((row) => row.id)).toEqual(["new"]);
    const bad = await call("/api/functions/score/invocations?limit=1001");
    expect(bad.status).toBe(422);
    expect(bad.body?.code).toBe("function.invalid");
    connection.close();
  });

  it("prunes the larger of the age and row caps, one batch at a time", () => {
    return open().then(({ connection, projectKey }) => {
      const now = new Date("2026-06-01T00:00:00.000Z");
      for (let index = 0; index < 6; index += 1) {
        insert(connection, projectKey, `old-${index}`, new Date(now.getTime() - 40 * 24 * 60 * 60 * 1000 - index * 1000).toISOString());
      }
      for (let index = 0; index < 4; index += 1) {
        insert(connection, projectKey, `new-${index}`, new Date(now.getTime() - index * 1000).toISOString());
      }
      const env = { [FUNCTION_HISTORY_DAYS_ENV]: "30", [FUNCTION_HISTORY_MAX_ROWS_ENV]: "8" };
      const removed = pruneFunctionInvocations(connection, now, env, 2);
      expect(removed).toBe(2);
      const ids = connection.prepare(`SELECT id FROM function_invocations ORDER BY created_at ASC`).all() as Array<{ id: string }>;
      expect(ids.map((row) => row.id)).not.toContain("old-5");
      expect(ids.map((row) => row.id)).not.toContain("old-4");
      expect(ids).toHaveLength(8);

      const recentOnly = connection.prepare(`DELETE FROM function_invocations WHERE id LIKE 'old-%'`).run();
      expect(recentOnly.changes).toBe(4);
      for (let index = 0; index < 6; index += 1) {
        insert(connection, projectKey, `fresh-${index}`, new Date(now.getTime() - (10 - index) * 1000).toISOString());
      }
      const capped = pruneFunctionInvocations(connection, now, { [FUNCTION_HISTORY_MAX_ROWS_ENV]: "4", [FUNCTION_HISTORY_DAYS_ENV]: "30" }, 3);
      expect(capped).toBe(3);
      const kept = connection.prepare(`SELECT id FROM function_invocations ORDER BY created_at ASC`).all() as Array<{ id: string }>;
      expect(kept).toHaveLength(7);
      expect(kept[0]?.id).toBe("fresh-3");
      expect(() => functionHistoryLimits({ [FUNCTION_HISTORY_DAYS_ENV]: "nope" })).toThrow(/STAGEFLOW_FUNCTION_HISTORY_DAYS/);
      expect(() => functionHistoryLimits({ [FUNCTION_HISTORY_MAX_ROWS_ENV]: "0" })).toThrow(/STAGEFLOW_FUNCTION_HISTORY_MAX_ROWS/);
      connection.close();
    });
  });
});
