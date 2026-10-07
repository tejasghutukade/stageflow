import type { IncomingMessage, ServerResponse } from "node:http";
import { safeAudit, type AuditSink } from "../browser/auditSink.js";
import { parseHostGateContext } from "../browser/gateHandoff.js";
import { readLiveViewSessionRequest } from "../browser/liveViewPersisted.js";
import type {
  LiveViewDialogRejection,
  LiveViewInputEvent,
  LiveViewInputRejection,
  LiveViewMessage,
  LiveViewRelay,
} from "../browser/liveViewRelay.js";
import { loadHostConfig } from "../config/hostConfig.js";
import { createAgentBrowserLiveViewRelay } from "../browser/agentBrowserLiveViewRelay.js";
import { defaultBrowserRunner } from "../browser/browserTeardown.js";
import {
  createLiveViewSessionManager,
  type LiveViewSessionManager,
  type LiveViewSessionManagerOptions,
} from "../browser/liveViewSessions.js";
import {
  createLiveViewTicketService,
  type LiveViewCredential,
  type LiveViewTarget,
  type LiveViewTicketService,
} from "../browser/liveViewTickets.js";
import { LOCAL_BROWSER_SCOPE } from "../browser/profileStore.js";
import { readStagePersistedBrowserEnv } from "../browser/stageBrowserEnv.js";
import type { RunManager } from "../runtime/runManager.js";
import type { RunStore } from "../runstore/port.js";
import { matchLiveViewRoute } from "./liveViewPath.js";
import { enforceBearerAuth, type ControlTokens } from "./controlToken.js";

export const LIVE_VIEW_COOKIE = "sf_live_view";
export const LIVE_VIEW_CSRF_HEADER = "x-stageflow-live-view";
export const LIVE_VIEW_MAX_INPUT_BYTES = 64 * 1024;
export const LIVE_VIEW_MAX_DIALOG_BYTES = 8 * 1024;
export const LIVE_VIEW_HEARTBEAT_MS = 15_000;

const MAX_TICKET_BODY_BYTES = 1024;

const STREAMED = new Set<LiveViewMessage["type"]>(["frame", "status", "tabs", "url", "retarget", "dialog", "dialog_closed"]);

const INPUT_STATUS: Record<LiveViewInputRejection, number> = {
  batch_too_large: 413,
  rate_limited: 429,
  invalid_event: 400,
  not_array: 400,
  closed: 409,
  upstream_unavailable: 409,
};

export function isLiveViewPath(pathname: string): boolean {
  return matchLiveViewRoute(pathname) !== null;
}

export function isLiveViewInputPath(method: string, pathname: string): boolean {
  return method === "POST" && matchLiveViewRoute(pathname)?.kind === "input";
}

const DIALOG_STATUS: Record<LiveViewDialogRejection, number> = {
  no_dialog: 409,
  not_answerable: 400,
  invalid: 400,
  closed: 409,
};

export function isLiveViewDialogPath(method: string, pathname: string): boolean {
  return method === "POST" && matchLiveViewRoute(pathname)?.kind === "dialog";
}

export function applyLiveViewHeaders(res: ServerResponse): void {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
  res.setHeader("X-Content-Type-Options", "nosniff");
}

export type LiveViewRoutesOptions = {
  store: RunStore;
  controlTokens: ControlTokens;
  relay?: LiveViewRelay;
  audit?: AuditSink;
  tickets?: LiveViewTicketService;
  sessions?: LiveViewSessionManager;
  /** Owner scope of the request. Defaults to the fixed local scope. */
  resolveScope?: (req: IncomingMessage) => string;
  graceMs?: LiveViewSessionManagerOptions["graceMs"];
  setTimer?: LiveViewSessionManagerOptions["setTimer"];
  clearTimer?: LiveViewSessionManagerOptions["clearTimer"];
  now?: () => number;
  /** Production relay only: how long an unanswered page dialog waits before the Host dismisses it. */
  dialogTimeoutMs?: number;
  heartbeatMs?: number;
  setHeartbeat?: (fn: () => void, ms: number) => unknown;
  clearHeartbeat?: (handle: unknown) => void;
};

export type LiveViewRoutes = {
  handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
  /** Revokes the stage's credentials, then resolves once its relay session is closed. */
  revokeStage(runId: string, stageId: string): Promise<void>;
  revokeRun(runId: string): Promise<void>;
  /** Ends every stream, revokes every credential and closes every session; the Host keeps running. */
  dispose(): Promise<void>;
  /** Wires revoke-on-gate-close, revoke-before-browser-teardown and dispose-on-shutdown; returns an unsubscribe. */
  attach(manager: LiveViewManagerHooks): () => void;
};

export type LiveViewManagerHooks = Pick<RunManager, "onGateClosed" | "beforeBrowserTeardown" | "onShutdown">;

function send(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readCookie(req: IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie;
  if (typeof header !== "string") return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

function isSecureRequest(req: IncomingMessage): boolean {
  if ((req.socket as { encrypted?: boolean }).encrypted === true) return true;
  const forwarded = req.headers["x-forwarded-proto"];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
  return first?.toLowerCase() === "https";
}

/** Reads at most `max` bytes; resolves undefined when the body is larger (the rest is discarded). */
function readLimitedBody(req: IncomingMessage, max: number): Promise<Buffer | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk: Buffer | string) => {
      if (tooLarge) return;
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      size += buf.length;
      if (size > max) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(buf);
    });
    req.on("end", () => resolve(tooLarge ? undefined : Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function configuredDialogTimeoutMs(): number | undefined {
  try {
    return loadHostConfig().browserDialogTimeoutSeconds * 1000;
  } catch {
    return undefined;
  }
}

export function createLiveViewRoutes(options: LiveViewRoutesOptions): LiveViewRoutes {
  const { store, controlTokens } = options;
  const tickets = options.tickets ?? createLiveViewTicketService({ now: options.now });
  const resolveScope = options.resolveScope ?? (() => LOCAL_BROWSER_SCOPE);
  const heartbeatMs = options.heartbeatMs ?? LIVE_VIEW_HEARTBEAT_MS;
  const setHeartbeat =
    options.setHeartbeat ??
    ((fn: () => void, ms: number) => {
      const handle = setInterval(fn, ms);
      handle.unref();
      return handle;
    });
  const clearHeartbeat =
    options.clearHeartbeat ?? ((handle: unknown) => clearInterval(handle as NodeJS.Timeout));
  let relay = options.relay;
  const sessions =
    options.sessions ??
    createLiveViewSessionManager({
      relay: {
        open: (request) => {
          relay ??= createAgentBrowserLiveViewRelay({
            runner: defaultBrowserRunner,
            dialogTimeoutMs: options.dialogTimeoutMs ?? configuredDialogTimeoutMs(),
          });
          return relay.open(request);
        },
      },
      graceMs: options.graceMs,
      setTimer: options.setTimer,
      clearTimer: options.clearTimer,
      request: async (runId, stageId) => {
        const detail = await store.readRun(runId);
        const stage = detail.stages.find((s) => s.stage_id === stageId);
        return readLiveViewSessionRequest({
          runDir: store.getWorkspaceDir(runId),
          runId,
          stageId,
          profile: parseHostGateContext(stage?.pending_prompt).profile,
        });
      },
    });

  async function issueTicket(
    req: IncomingMessage,
    res: ServerResponse,
    target: LiveViewTarget,
  ): Promise<void> {
    const base = enforceBearerAuth(controlTokens, req, res, "read");
    if (!base.ok) return;
    const raw = await readLimitedBody(req, MAX_TICKET_BODY_BYTES);
    let mode: unknown;
    try {
      mode = raw === undefined ? undefined : (JSON.parse(raw.toString("utf8") || "{}") as { mode?: unknown }).mode;
    } catch {
      mode = undefined;
    }
    if (mode !== "view" && mode !== "control") {
      send(res, 400, { error: 'mode must be "view" or "control"' });
      return;
    }
    const auth = mode === "control" ? enforceBearerAuth(controlTokens, req, res, "drive") : base;
    if (!auth.ok) return;

    let detail;
    try {
      detail = await store.readRun(target.runId);
    } catch {
      send(res, 404, { error: `Run not found: ${target.runId}` });
      return;
    }
    const stage = detail.stages.find((s) => s.stage_id === target.stageId);
    if (stage === undefined) {
      send(res, 404, { error: `Stage not found: ${target.stageId}` });
      return;
    }
    if (mode === "control") {
      const handoff = parseHostGateContext(stage.pending_prompt).handoff;
      if (stage.status !== "waiting_for_input" || handoff?.kind !== "live_view") {
        send(res, 409, {
          error: "Control is only available while the stage waits at a live view gate",
          code: "no_live_view_gate",
        });
        return;
      }
    } else {
      const live = stage.status === "running" || stage.status === "waiting_for_input";
      const env = live
        ? await readStagePersistedBrowserEnv(store.getWorkspaceDir(target.runId), target.stageId).catch(
            () => undefined,
          )
        : undefined;
      if (env === undefined) {
        send(res, 409, {
          error: "Stage has no browser to show",
          code: "no_browser",
        });
        return;
      }
    }
    const issued = tickets.issue({
      ...target,
      mode,
      callerId: auth.auth?.caller_id ?? null,
    });
    send(res, 200, {
      ticket: issued.ticket,
      expires_at: new Date(issued.expiresAt).toISOString(),
    });
  }

  function audit(event: "live_view_opened" | "live_view_closed", grant: LiveViewCredential): void {
    void safeAudit(options.audit, {
      event,
      scope: grant.scope,
      runId: grant.runId,
      stageId: grant.stageId,
      mode: grant.mode,
      callerId: grant.callerId,
    });
  }

  async function openStream(
    req: IncomingMessage,
    res: ServerResponse,
    target: LiveViewTarget,
    pathPrefix: string,
    ticket: string | null,
  ): Promise<void> {
    let grant = ticket !== null ? tickets.redeem(ticket, target) : undefined;
    const redeemed = grant !== undefined;
    if (grant === undefined) {
      const cookie = readCookie(req, LIVE_VIEW_COOKIE);
      grant = cookie !== undefined ? tickets.resolve(cookie, target) : undefined;
    }
    if (grant === undefined) {
      send(res, 401, { error: "Invalid or expired live view ticket", code: "ticket_invalid" });
      return;
    }
    const credential = grant.credential;

    let lease;
    try {
      lease = await sessions.acquire(target.runId, target.stageId);
    } catch {
      send(res, 409, { error: "Live view is unavailable", code: "live_view_unavailable" });
      return;
    }
    if (lease === undefined) {
      send(res, 409, { error: "Stage has no browser to show", code: "no_browser" });
      return;
    }
    if (tickets.resolve(credential, target) === undefined) {
      lease.release();
      send(res, 401, { error: "Live view session ended", code: "session_ended" });
      return;
    }

    const headers: Record<string, string | string[]> = {
      "Content-Type": "text/event-stream; charset=utf-8",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    };
    if (redeemed) {
      headers["Set-Cookie"] =
        `${LIVE_VIEW_COOKIE}=${credential}; Path=${pathPrefix}; HttpOnly; SameSite=Strict${isSecureRequest(req) ? "; Secure" : ""}`;
    }
    res.writeHead(200, headers);
    res.flushHeaders();
    audit("live_view_opened", grant);

    const activeGrant = grant;
    let ended = false;
    const heartbeat = setHeartbeat(() => {
      if (!ended) res.write(": keepalive\n\n");
    }, heartbeatMs);
    let unsubscribe: () => void = () => undefined;
    let stopRevoked: () => void = () => undefined;

    const finish = (final?: LiveViewMessage) => {
      if (ended) return;
      ended = true;
      clearHeartbeat(heartbeat);
      unsubscribe();
      stopRevoked();
      lease.release();
      audit("live_view_closed", activeGrant);
      if (!res.writableEnded && !res.destroyed) {
        if (final !== undefined) res.write(`event: ${final.type}\ndata: ${JSON.stringify(final.data)}\n\n`);
        res.end();
      }
    };

    stopRevoked = tickets.onRevoked((revoked) => {
      if (revoked.includes(credential)) finish({ type: "closed", data: { reason: "revoked" } });
    });
    res.on("close", () => finish());
    unsubscribe = lease.session.subscribe((message) => {
      if (ended) return;
      if (message.type === "closed") {
        finish(message);
        return;
      }
      if (!STREAMED.has(message.type)) return;
      if (message.type === "frame" && res.writableNeedDrain) return;
      res.write(`event: ${message.type}\ndata: ${JSON.stringify(message.data)}\n\n`);
    });
    if (ended) unsubscribe();
  }

  /** Cookie credential, anti-forgery header, control mode, then a size-limited JSON body. */
  async function readControlBody(
    req: IncomingMessage,
    res: ServerResponse,
    target: LiveViewTarget,
    max: number,
    viewOnlyError: string,
    tooLargeError: string,
  ): Promise<{ body: unknown } | undefined> {
    const cookie = readCookie(req, LIVE_VIEW_COOKIE);
    const grant = cookie !== undefined ? tickets.resolve(cookie, target) : undefined;
    if (grant === undefined) {
      req.resume();
      send(res, 401, { error: "Live view session required", code: "session_required" });
      return undefined;
    }
    if (req.headers[LIVE_VIEW_CSRF_HEADER] !== "1") {
      req.resume();
      send(res, 403, { error: "Missing live view request header", code: "csrf_header_required" });
      return undefined;
    }
    if (grant.mode !== "control") {
      req.resume();
      send(res, 403, { error: viewOnlyError, code: "view_only" });
      return undefined;
    }
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > max) {
      req.resume();
      send(res, 413, { error: tooLargeError, code: "batch_too_large" });
      return undefined;
    }
    const raw = await readLimitedBody(req, max);
    if (raw === undefined) {
      send(res, 413, { error: tooLargeError, code: "batch_too_large" });
      return undefined;
    }
    try {
      return { body: JSON.parse(raw.toString("utf8")) };
    } catch {
      send(res, 400, { error: "Invalid JSON body", code: "invalid_json" });
      return undefined;
    }
  }

  async function postDialog(
    req: IncomingMessage,
    res: ServerResponse,
    target: LiveViewTarget,
  ): Promise<void> {
    const read = await readControlBody(
      req,
      res,
      target,
      LIVE_VIEW_MAX_DIALOG_BYTES,
      "This live view session cannot answer dialogs",
      "Dialog answer too large",
    );
    if (read === undefined) return;
    const session = sessions.peek(target.runId, target.stageId);
    if (session === undefined) {
      send(res, 409, { error: "Live view is closed", code: "closed" });
      return;
    }
    const body = read.body;
    const fields =
      typeof body === "object" && body !== null && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : undefined;
    if (
      fields === undefined ||
      typeof fields.id !== "string" ||
      typeof fields.accept !== "boolean" ||
      (fields.promptText !== undefined && typeof fields.promptText !== "string")
    ) {
      send(res, 400, { error: "invalid", code: "invalid" });
      return;
    }
    const result = await session.answerDialog({
      id: fields.id,
      accept: fields.accept,
      ...(typeof fields.promptText === "string" ? { promptText: fields.promptText } : {}),
    });
    if (result.ok) {
      send(res, 200, { ok: true });
      return;
    }
    send(res, DIALOG_STATUS[result.reason], { error: result.reason, code: result.reason });
  }

  async function postInput(
    req: IncomingMessage,
    res: ServerResponse,
    target: LiveViewTarget,
  ): Promise<void> {
    const read = await readControlBody(
      req,
      res,
      target,
      LIVE_VIEW_MAX_INPUT_BYTES,
      "This live view session cannot send input",
      "Input batch too large",
    );
    if (read === undefined) return;
    const events = read.body;
    const session = sessions.peek(target.runId, target.stageId);
    if (session === undefined) {
      send(res, 409, { error: "Live view is closed", code: "closed" });
      return;
    }
    const result = await session.sendInput(events as readonly LiveViewInputEvent[]);
    if (result.ok) {
      send(res, 200, { accepted: result.accepted });
      return;
    }
    send(res, INPUT_STATUS[result.reason], { error: result.reason, code: result.reason });
  }

  const routes: LiveViewRoutes = {
    attach(manager) {
      const offs = [
        manager.onGateClosed((runId, stageId) => {
          if (stageId === undefined) void routes.revokeRun(runId);
          else void routes.revokeStage(runId, stageId);
        }),
        manager.beforeBrowserTeardown(({ runId, stageId }) =>
          stageId === undefined ? routes.revokeRun(runId) : routes.revokeStage(runId, stageId),
        ),
        manager.onShutdown(() => void routes.dispose()),
      ];
      return () => {
        for (const off of offs) off();
      };
    },
    async handle(req, res) {
      const method = req.method ?? "GET";
      const url = new URL(req.url ?? "/", "http://localhost");
      const match = matchLiveViewRoute(url.pathname);
      if (match === null) return false;
      const { rawRunId: rawRun, rawStageId: rawStage, kind: action } = match;
      let target: LiveViewTarget;
      try {
        target = {
          scope: resolveScope(req),
          runId: decodeURIComponent(rawRun),
          stageId: decodeURIComponent(rawStage),
        };
      } catch {
        send(res, 400, { error: "Invalid path" });
        return true;
      }
      const pathPrefix = `/api/runs/${rawRun}/stages/${rawStage}/live-view`;
      try {
        if (action === "ticket" && method === "POST") {
          await issueTicket(req, res, target);
        } else if (action === "events" && method === "GET") {
          await openStream(req, res, target, pathPrefix, url.searchParams.get("ticket"));
        } else if (action === "input" && method === "POST") {
          await postInput(req, res, target);
        } else if (action === "dialog" && method === "POST") {
          await postDialog(req, res, target);
        } else {
          send(res, 405, { error: "Method not allowed" });
        }
      } catch {
        if (!res.headersSent) send(res, 500, { error: "Live view request failed" });
        else if (!res.writableEnded) res.end();
      }
      return true;
    },
    revokeStage(runId, stageId) {
      tickets.revoke(runId, stageId);
      return sessions.closeStage(runId, stageId);
    },
    revokeRun(runId) {
      tickets.revokeRun(runId);
      return sessions.closeRun(runId);
    },
    dispose() {
      tickets.revokeAll();
      return sessions.dispose();
    },
  };
  return routes;
}
