import type { BrowserEnv, BrowserRunner } from "./browserHost.js";
import type {
  LiveViewDialog,
  LiveViewDialogAnswer,
  LiveViewDialogCloseResult,
  LiveViewDialogKind,
  LiveViewDialogResult,
  LiveViewInputEvent,
  LiveViewInputRejection,
  LiveViewInputResult,
  LiveViewMessage,
  LiveViewRelay,
  LiveViewSession,
  LiveViewSessionRequest,
  LiveViewSubscriber,
} from "./liveViewRelay.js";

export const DEFAULT_MAX_INPUT_BATCH = 64;
export const DEFAULT_MAX_INPUT_EVENTS_PER_SECOND = 500;

const MAX_COORDINATE = 20_000;
const MAX_DELTA = 100_000;
const MAX_TEXT_LENGTH = 32;
const MAX_TOUCH_POINTS = 10;
const STATUS_TIMEOUT_MS = 10_000;
const MAX_QUEUED_BATCHES = 16;
const TAB_LIST_TRIES = 5;
const RECONNECT_TRIES = 3;
const RETARGET_ATTEMPTS = 2;
const DEFAULT_FIRST_FRAME_TIMEOUT_MS = 1500;
const FORWARDED = new Set(["frame", "status", "tabs", "url"]);
const DEFAULT_DIALOG_TIMEOUT_MS = 60_000;
const MAX_DIALOG_TEXT = 2000;
const MAX_DIALOG_ID = 64;
const DIALOG_KINDS: readonly string[] = ["alert", "confirm", "prompt", "beforeunload"];
const CDP_NO_DIALOG = -32602;
const REPLAYED = ["status", "tabs", "url", "frame"] as const;
type Replayed = (typeof REPLAYED)[number];

export type LiveViewRelayErrorCode = "stream_port_unavailable" | "stream_connect_failed";

export class LiveViewRelayError extends Error {
  constructor(readonly code: LiveViewRelayErrorCode, message: string) {
    super(message);
    this.name = "LiveViewRelayError";
  }
}

export type WebSocketLike = {
  readonly readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  send(data: string): void;
  close(): void;
};

export type WebSocketConstructor = new (url: string) => WebSocketLike;

export type AgentBrowserLiveViewRelayOptions = {
  runner: BrowserRunner;
  WebSocketImpl?: WebSocketConstructor;
  maxBatch?: number;
  maxEventsPerSecond?: number;
  now?: () => number;
  /** Pause between re-target polls of the tab list and stream reconnects. */
  retryDelayMs?: number;
  /** How long a fresh stream connection may stay frameless before one restart nudge. */
  firstFrameTimeoutMs?: number;
  /** An open confirm or prompt nobody answers is dismissed after this long. */
  dialogTimeoutMs?: number;
  /** Timer seam for the first-frame nudge and the dialog time-out; returns a cancel function. */
  schedule?: (fn: () => void, ms: number) => () => void;
};

const WS_OPEN = 1;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function oneOf(value: unknown, options: readonly string[]): boolean {
  return typeof value === "string" && options.includes(value);
}

function isNumberIn(value: unknown, min: number, max: number): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

function isIntIn(value: unknown, min: number, max: number): boolean {
  return isNumberIn(value, min, max) && Number.isInteger(value);
}

function optional(value: unknown, check: (v: unknown) => boolean): boolean {
  return value === undefined || check(value);
}

function shortString(value: unknown): boolean {
  return typeof value === "string" && value.length <= MAX_TEXT_LENGTH;
}

function validMouse(e: Record<string, unknown>): boolean {
  return (
    onlyKeys(e, ["type", "eventType", "x", "y", "button", "clickCount", "deltaX", "deltaY", "modifiers"]) &&
    oneOf(e.eventType, ["mousePressed", "mouseReleased", "mouseMoved", "mouseWheel"]) &&
    isNumberIn(e.x, 0, MAX_COORDINATE) &&
    isNumberIn(e.y, 0, MAX_COORDINATE) &&
    optional(e.button, (v) => oneOf(v, ["left", "middle", "right"])) &&
    optional(e.clickCount, (v) => isIntIn(v, 0, 3)) &&
    optional(e.deltaX, (v) => isNumberIn(v, -MAX_DELTA, MAX_DELTA)) &&
    optional(e.deltaY, (v) => isNumberIn(v, -MAX_DELTA, MAX_DELTA)) &&
    optional(e.modifiers, (v) => isIntIn(v, 0, 15))
  );
}

function validKeyboard(e: Record<string, unknown>): boolean {
  return (
    onlyKeys(e, ["type", "eventType", "key", "code", "text", "windowsVirtualKeyCode", "modifiers"]) &&
    oneOf(e.eventType, ["keyDown", "keyUp", "char"]) &&
    optional(e.key, shortString) &&
    optional(e.code, shortString) &&
    optional(e.text, shortString) &&
    optional(e.windowsVirtualKeyCode, (v) => isIntIn(v, 0, 255)) &&
    optional(e.modifiers, (v) => isIntIn(v, 0, 15))
  );
}

function validTouchPoint(p: unknown): boolean {
  return (
    isPlainObject(p) &&
    onlyKeys(p, ["x", "y", "id"]) &&
    isNumberIn(p.x, 0, MAX_COORDINATE) &&
    isNumberIn(p.y, 0, MAX_COORDINATE) &&
    optional(p.id, (v) => isIntIn(v, 0, 1_000_000))
  );
}

function validTouch(e: Record<string, unknown>): boolean {
  return (
    onlyKeys(e, ["type", "eventType", "touchPoints", "modifiers"]) &&
    oneOf(e.eventType, ["touchStart", "touchMove", "touchEnd", "touchCancel"]) &&
    Array.isArray(e.touchPoints) &&
    e.touchPoints.length <= MAX_TOUCH_POINTS &&
    e.touchPoints.every(validTouchPoint) &&
    optional(e.modifiers, (v) => isIntIn(v, 0, 15))
  );
}

export function validEvent(event: unknown): boolean {
  if (!isPlainObject(event)) return false;
  switch (event.type) {
    case "input_mouse":
      return validMouse(event);
    case "input_keyboard":
      return validKeyboard(event);
    case "input_touch":
      return validTouch(event);
    default:
      return false;
  }
}

async function readStreamPort(runner: BrowserRunner, env: BrowserEnv): Promise<number | undefined> {
  let result: Awaited<ReturnType<BrowserRunner>>;
  try {
    result = await runner(["stream", "status", "--json"], env, { timeoutMs: STATUS_TIMEOUT_MS });
  } catch {
    return undefined;
  }
  if (result.code !== 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(result.stdout ?? "");
    const data = isPlainObject(parsed) && isPlainObject(parsed.data) ? parsed.data : undefined;
    const port = data?.port;
    if (data?.enabled === false) return undefined;
    return typeof port === "number" && Number.isInteger(port) && port > 0 && port < 65536
      ? port
      : undefined;
  } catch {
    return undefined;
  }
}

async function findStreamPort(runner: BrowserRunner, env: BrowserEnv): Promise<number> {
  let port = await readStreamPort(runner, env);
  if (port === undefined) {
    try {
      await runner(["stream", "enable", "--json"], env, { timeoutMs: STATUS_TIMEOUT_MS });
    } catch {
      // the follow-up status read decides
    }
    port = await readStreamPort(runner, env);
  }
  if (port === undefined) {
    throw new LiveViewRelayError(
      "stream_port_unavailable",
      "agent-browser did not report a stream port",
    );
  }
  return port;
}

function connect(Impl: WebSocketConstructor, url: string): Promise<WebSocketLike> {
  return new Promise((resolve, reject) => {
    let ws: WebSocketLike;
    const fail = () =>
      reject(new LiveViewRelayError("stream_connect_failed", "could not connect to the browser stream"));
    try {
      ws = new Impl(url);
    } catch {
      fail();
      return;
    }
    ws.onopen = () => resolve(ws);
    ws.onerror = fail;
    ws.onclose = fail;
  });
}

const streamUrl = (port: number) => `ws://127.0.0.1:${port}`;

async function readCdpAddress(
  runner: BrowserRunner,
  request: LiveViewSessionRequest,
): Promise<string | undefined> {
  const known = request.cdpAddress ?? request.env.AGENT_BROWSER_CDP;
  if (known !== undefined) return known;
  try {
    const result = await runner(["get", "cdp-url"], request.env, { timeoutMs: STATUS_TIMEOUT_MS });
    const out = (result.stdout ?? "").trim();
    return result.code === 0 && /^wss?:\/\//.test(out) ? out : undefined;
  } catch {
    return undefined;
  }
}

type TabEntry = { tabId: string; url: string };

function findTab(stdout: string | undefined, targetId: string): TabEntry | undefined {
  try {
    const parsed: unknown = JSON.parse(stdout ?? "");
    const tabs = isPlainObject(parsed) && isPlainObject(parsed.data) ? parsed.data.tabs : undefined;
    if (!Array.isArray(tabs)) return undefined;
    for (const tab of tabs) {
      if (isPlainObject(tab) && tab.targetId === targetId && typeof tab.tabId === "string") {
        return { tabId: tab.tabId, url: typeof tab.url === "string" ? tab.url : "" };
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

type CdpReply = { result?: unknown; error?: { code?: number } } | undefined;
type OpenDialog = {
  dialog: LiveViewDialog;
  sessionId: string;
  answered: boolean;
  cancelTimer?: () => void;
};

const clip = (value: unknown): string =>
  typeof value === "string" ? value.slice(0, MAX_DIALOG_TEXT) : "";

type RetargetReason = "popup_opened" | "tab_closed";
type PageInfo = { opener?: string; url: string };

export function createAgentBrowserLiveViewRelay(
  options: AgentBrowserLiveViewRelayOptions,
): LiveViewRelay {
  const Impl = options.WebSocketImpl ?? (globalThis.WebSocket as unknown as WebSocketConstructor);
  const maxBatch = options.maxBatch ?? DEFAULT_MAX_INPUT_BATCH;
  const maxPerSecond = options.maxEventsPerSecond ?? DEFAULT_MAX_INPUT_EVENTS_PER_SECOND;
  const now = options.now ?? Date.now;
  const retryDelayMs = options.retryDelayMs ?? 100;
  const dialogTimeoutMs = options.dialogTimeoutMs ?? DEFAULT_DIALOG_TIMEOUT_MS;
  const firstFrameTimeoutMs = options.firstFrameTimeoutMs ?? DEFAULT_FIRST_FRAME_TIMEOUT_MS;
  const schedule =
    options.schedule ??
    ((fn: () => void, ms: number) => {
      const timer = setTimeout(fn, ms);
      return () => clearTimeout(timer);
    });

  return {
    async open(request: LiveViewSessionRequest): Promise<LiveViewSession> {
      const port = await findStreamPort(options.runner, request.env);
      let ws: WebSocketLike | undefined = await connect(Impl, streamUrl(port));
      const cdpAddress = await readCdpAddress(options.runner, request);
      let cdp: WebSocketLike | undefined;
      if (cdpAddress !== undefined) {
        cdp = await connect(Impl, cdpAddress).catch(() => undefined);
      }

      const subscribers = new Set<LiveViewSubscriber>();
      const latest = new Map<Replayed, LiveViewMessage>();
      const timers = new Set<{ timer: ReturnType<typeof setTimeout>; done: () => void }>();
      const queued: Array<{ events: readonly LiveViewInputEvent[]; done: (r: LiveViewInputResult) => void }> = [];
      const pages = new Map<string, PageInfo>();
      let current: string | undefined;
      let desired: { target: string; reason: RetargetReason } | undefined;
      let running = false;
      let retargeting = false;
      let closed = false;
      let frameSeen = false;
      let cancelNudge: (() => void) | undefined;
      const targetSessions = new Map<string, string>();
      const sessionTargets = new Map<string, string>();
      const openDialogs = new Map<string, OpenDialog>();
      const cdpPending = new Map<number, (reply: CdpReply) => void>();
      let dialogSeq = 0;
      let cdpSeq = 0;
      let windowStart = now();
      let windowCount = 0;

      const dropSocket = (socket: WebSocketLike | undefined) => {
        if (socket === undefined) return;
        socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
        try {
          socket.close();
        } catch {
          // already closing
        }
      };

      const finish = (reason: string) => {
        if (closed) return;
        closed = true;
        cancelNudge?.();
        for (const open of openDialogs.values()) open.cancelTimer?.();
        openDialogs.clear();
        dropSocket(ws);
        dropSocket(cdp);
        ws = cdp = undefined;
        for (const done of [...cdpPending.values()]) done(undefined);
        cdpPending.clear();
        for (const { timer, done } of [...timers]) {
          clearTimeout(timer);
          done();
        }
        timers.clear();
        for (const batch of queued.splice(0)) batch.done({ ok: false, reason: "closed" });
        desired = undefined;
        const message: LiveViewMessage = { type: "closed", data: { reason } };
        const targets = [...subscribers];
        subscribers.clear();
        latest.clear();
        for (const subscriber of targets) subscriber(message);
      };

      const pause = () =>
        new Promise<void>((resolve) => {
          const entry = {
            timer: setTimeout(() => {
              timers.delete(entry);
              resolve();
            }, retryDelayMs),
            done: resolve,
          };
          timers.add(entry);
        });

      const broadcast = (message: LiveViewMessage) => {
        for (const subscriber of [...subscribers]) subscriber(message);
      };

      const cdpSend = (method: string, params: Record<string, unknown>, sessionId?: string): number | undefined => {
        const socket = cdp;
        if (socket === undefined || socket.readyState !== WS_OPEN) return undefined;
        const id = ++cdpSeq;
        try {
          socket.send(JSON.stringify({ id, method, params, sessionId }));
        } catch {
          return undefined;
        }
        return id;
      };

      const cdpCall = (method: string, params: Record<string, unknown>, sessionId: string): Promise<CdpReply> =>
        new Promise((resolve) => {
          const id = cdpSend(method, params, sessionId);
          if (id === undefined) {
            resolve(undefined);
            return;
          }
          cdpPending.set(id, resolve);
        });

      const endDialog = (open: OpenDialog, result: LiveViewDialogCloseResult) => {
        if (openDialogs.get(open.dialog.id) !== open) return;
        openDialogs.delete(open.dialog.id);
        open.cancelTimer?.();
        broadcast({ type: "dialog_closed", data: { id: open.dialog.id, result } });
      };

      const endDialogsWhere = (match: (open: OpenDialog) => boolean, result: LiveViewDialogCloseResult) => {
        for (const open of [...openDialogs.values()]) if (match(open)) endDialog(open, result);
      };

      const expireDialog = async (open: OpenDialog) => {
        open.cancelTimer = undefined;
        if (open.answered || openDialogs.get(open.dialog.id) !== open) return;
        open.answered = true;
        const reply = await cdpCall("Page.handleJavaScriptDialog", { accept: false }, open.sessionId);
        if (reply === undefined) return;
        if (reply.error === undefined || reply.error.code === CDP_NO_DIALOG) endDialog(open, "timeout");
      };

      const onDialogOpening = (sessionId: string, params: Record<string, unknown>) => {
        const targetId = sessionTargets.get(sessionId);
        if (targetId === undefined || typeof params.type !== "string" || !DIALOG_KINDS.includes(params.type)) return;
        endDialogsWhere((open) => open.sessionId === sessionId, "closed_by_page");
        const kind = params.type as LiveViewDialogKind;
        const answerable = kind === "confirm" || kind === "prompt";
        const dialog: LiveViewDialog = {
          id: `d${++dialogSeq}`,
          kind,
          message: clip(params.message),
          defaultPrompt: clip(params.defaultPrompt),
          targetId,
          answerable,
        };
        const open: OpenDialog = { dialog, sessionId, answered: false };
        openDialogs.set(dialog.id, open);
        if (answerable) open.cancelTimer = schedule(() => void expireDialog(open), dialogTimeoutMs);
        broadcast({ type: "dialog", data: dialog });
      };

      const onDialogClosed = (sessionId: string, params: Record<string, unknown>) => {
        endDialogsWhere(
          (open) => open.sessionId === sessionId,
          params.result === true ? "accepted" : "dismissed",
        );
      };

      const onAttached = (params: Record<string, unknown>) => {
        const sessionId = params.sessionId;
        if (typeof sessionId !== "string") return;
        const info = params.targetInfo;
        if (isPlainObject(info) && info.type === "page" && typeof info.targetId === "string") {
          targetSessions.set(info.targetId, sessionId);
          sessionTargets.set(sessionId, info.targetId);
          cdpSend("Page.enable", {}, sessionId);
        }
        if (params.waitingForDebugger === true) cdpSend("Runtime.runIfWaitingForDebugger", {}, sessionId);
      };

      const onDetached = (params: Record<string, unknown>) => {
        const sessionId = params.sessionId;
        if (typeof sessionId !== "string") return;
        const targetId = sessionTargets.get(sessionId);
        sessionTargets.delete(sessionId);
        if (targetId !== undefined && targetSessions.get(targetId) === sessionId) targetSessions.delete(targetId);
        endDialogsWhere((open) => open.sessionId === sessionId, "closed_by_page");
      };

      const attachStream = (socket: WebSocketLike) => {
        socket.onmessage = (event) => {
          if (closed || typeof event.data !== "string") return;
          let parsed: unknown;
          try {
            parsed = JSON.parse(event.data);
          } catch {
            return;
          }
          if (!isPlainObject(parsed) || typeof parsed.type !== "string") return;
          if (!FORWARDED.has(parsed.type)) return;
          if (parsed.type === "frame") frameSeen = true;
          const { type, ...data } = parsed;
          const message = { type, data } as LiveViewMessage;
          latest.set(type as Replayed, message);
          for (const subscriber of [...subscribers]) subscriber(message);
        };
        socket.onclose = () => finish("upstream_closed");
      };
      attachStream(ws);

      const run = async (args: string[]): Promise<{ code: number | null; stdout?: string } | undefined> => {
        try {
          return await options.runner(args, request.env, { timeoutMs: STATUS_TIMEOUT_MS });
        } catch {
          return undefined;
        }
      };

      const resolveTab = async (target: string): Promise<TabEntry | undefined> => {
        for (let i = 0; i < TAB_LIST_TRIES && !closed; i++) {
          const listed = await run(["tab", "--json"]);
          if (listed === undefined || listed.code !== 0) return undefined;
          const tab = findTab(listed.stdout, target);
          if (tab !== undefined) return tab;
          if (i < TAB_LIST_TRIES - 1) await pause();
        }
        return undefined;
      };

      const reconnect = async (): Promise<WebSocketLike | undefined> => {
        for (let i = 0; i < RECONNECT_TRIES && !closed; i++) {
          try {
            return await connect(Impl, streamUrl(port));
          } catch {
            if (i < RECONNECT_TRIES - 1) await pause();
          }
        }
        return undefined;
      };

      const restartStream = async (): Promise<boolean> => {
        dropSocket(ws);
        ws = undefined;
        if ((await run(["stream", "disable"]))?.code !== 0 || closed) return false;
        if ((await run(["stream", "enable", "--port", String(port)]))?.code !== 0 || closed) return false;
        const fresh = await reconnect();
        if (fresh === undefined) return false;
        if (closed) {
          dropSocket(fresh);
          return false;
        }
        ws = fresh;
        attachStream(fresh);
        frameSeen = false;
        return true;
      };

      const armNudge = () => {
        cancelNudge?.();
        cancelNudge = schedule(() => {
          cancelNudge = undefined;
          if (!closed && !frameSeen && !running) void nudge();
        }, firstFrameTimeoutMs);
      };

      const nudge = async () => {
        running = true;
        retargeting = true;
        const ok = await restartStream();
        running = false;
        retargeting = false;
        if (closed) return;
        if (!ok) {
          finish("nudge_failed");
          return;
        }
        flushQueued();
        if (desired !== undefined) void retargetLoop();
      };

      const attemptRetarget = async (target: string, reason: RetargetReason): Promise<boolean> => {
        const tab = await resolveTab(target);
        if (tab === undefined || closed) return false;
        if ((await run(["tab", tab.tabId]))?.code !== 0 || closed) return false;
        if (!(await restartStream())) return false;
        current = target;
        latest.delete("frame");
        armNudge();
        const message: LiveViewMessage = { type: "retarget", data: { tab: tab.tabId, url: tab.url, reason } };
        for (const subscriber of [...subscribers]) subscriber(message);
        const fresh = pages.get(target)?.url ?? "";
        if (fresh !== "") {
          const urlMessage: LiveViewMessage = { type: "url", data: { url: fresh } };
          latest.set("url", urlMessage);
          if (fresh !== tab.url) for (const subscriber of [...subscribers]) subscriber(urlMessage);
        }
        return true;
      };

      const flushQueued = () => {
        for (const batch of queued.splice(0)) {
          if (ws === undefined || ws.readyState !== WS_OPEN) {
            batch.done({ ok: false, reason: "upstream_unavailable" });
            continue;
          }
          for (const event of batch.events) ws.send(JSON.stringify(event));
          batch.done({ ok: true, accepted: batch.events.length });
        }
      };

      const retargetLoop = async () => {
        running = true;
        retargeting = true;
        cancelNudge?.();
        cancelNudge = undefined;
        while (desired !== undefined && !closed) {
          const { target, reason } = desired;
          desired = undefined;
          if (target === current || !pages.has(target)) continue;
          let ok = false;
          for (let attempt = 0; attempt < RETARGET_ATTEMPTS && !ok && !closed; attempt++) {
            ok = await attemptRetarget(target, reason);
          }
          if (closed) break;
          if (!ok) {
            finish("retarget_failed");
            break;
          }
        }
        running = false;
        retargeting = false;
        if (!closed) flushQueued();
      };

      const want = (target: string, reason: RetargetReason) => {
        desired = { target, reason };
        if (!running) void retargetLoop();
      };

      const publishUrl = (url: string) => {
        const known = latest.get("url")?.data as { url?: unknown } | undefined;
        if (url === "" || known?.url === url) return;
        const message: LiveViewMessage = { type: "url", data: { url } };
        latest.set("url", message);
        for (const subscriber of [...subscribers]) subscriber(message);
      };

      const onTarget = (method: string, params: Record<string, unknown>) => {
        if (closed) return;
        if (method === "Target.targetDestroyed") {
          const id = params.targetId;
          if (typeof id !== "string") return;
          const gone = pages.get(id);
          pages.delete(id);
          const session = targetSessions.get(id);
          targetSessions.delete(id);
          if (session !== undefined) {
            sessionTargets.delete(session);
            endDialogsWhere((open) => open.sessionId === session, "closed_by_page");
          }
          if (desired?.target === id) desired = undefined;
          if (gone !== undefined && id === current) {
            const back = gone.opener !== undefined && pages.has(gone.opener) ? gone.opener : [...pages.keys()].at(-1);
            if (back !== undefined) want(back, "tab_closed");
          }
          return;
        }
        const info = params.targetInfo;
        if (!isPlainObject(info) || info.type !== "page" || typeof info.targetId !== "string") return;
        const id = info.targetId;
        const url = typeof info.url === "string" ? info.url : "";
        const opener = typeof info.openerId === "string" ? info.openerId : undefined;
        const isNew = !pages.has(id);
        pages.set(id, { opener: opener ?? pages.get(id)?.opener, url });
        if (current === undefined && /^https?:/.test(url)) current = id;
        if (id === current) publishUrl(url);
        if (isNew && opener !== undefined) want(id, "popup_opened");
      };

      if (cdp !== undefined) {
        cdp.onmessage = (event) => {
          if (typeof event.data !== "string") return;
          try {
            const parsed: unknown = JSON.parse(event.data);
            if (!isPlainObject(parsed)) return;
            if (typeof parsed.id === "number") {
              const done = cdpPending.get(parsed.id);
              if (done === undefined) return;
              cdpPending.delete(parsed.id);
              const error = isPlainObject(parsed.error) ? parsed.error : undefined;
              done(error === undefined ? { result: parsed.result } : { error: { code: typeof error.code === "number" ? error.code : undefined } });
              return;
            }
            if (typeof parsed.method !== "string" || !isPlainObject(parsed.params)) return;
            const sessionId = typeof parsed.sessionId === "string" ? parsed.sessionId : undefined;
            switch (parsed.method) {
              case "Target.targetCreated":
              case "Target.targetInfoChanged":
              case "Target.targetDestroyed":
                onTarget(parsed.method, parsed.params);
                break;
              case "Target.attachedToTarget":
                if (!closed) onAttached(parsed.params);
                break;
              case "Target.detachedFromTarget":
                if (!closed) onDetached(parsed.params);
                break;
              case "Page.javascriptDialogOpening":
                if (!closed && sessionId !== undefined) onDialogOpening(sessionId, parsed.params);
                break;
              case "Page.javascriptDialogClosed":
                if (!closed && sessionId !== undefined) onDialogClosed(sessionId, parsed.params);
                break;
            }
          } catch {
            return;
          }
        };
        const watcher = cdp;
        watcher.onclose = () => {
          watcher.onmessage = watcher.onclose = null;
          if (cdp !== watcher) return;
          cdp = undefined;
          for (const done of [...cdpPending.values()]) done(undefined);
          cdpPending.clear();
          targetSessions.clear();
          sessionTargets.clear();
          endDialogsWhere(() => true, "closed_by_page");
        };
        cdpSend("Target.setDiscoverTargets", { discover: true });
        cdpSend("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
      }

      armNudge();

      const reject = (reason: LiveViewInputRejection): LiveViewInputResult => ({ ok: false, reason });

      return {
        subscribe(subscriber) {
          if (closed) {
            subscriber({ type: "closed", data: { reason: "closed" } });
            return () => {};
          }
          for (const type of REPLAYED) {
            if (type === "frame") {
              for (const { dialog } of openDialogs.values()) subscriber({ type: "dialog", data: dialog });
            }
            const message = latest.get(type);
            if (message !== undefined) subscriber(message);
          }
          subscribers.add(subscriber);
          return () => {
            subscribers.delete(subscriber);
          };
        },
        async sendInput(events: readonly LiveViewInputEvent[]) {
          if (closed) return reject("closed");
          if (!Array.isArray(events)) return reject("not_array");
          if (events.length > maxBatch) return reject("batch_too_large");
          if (!events.every(validEvent)) return reject("invalid_event");
          const at = now();
          if (at - windowStart >= 1000 || at < windowStart) {
            windowStart = at;
            windowCount = 0;
          }
          if (windowCount + events.length > maxPerSecond) return reject("rate_limited");
          if (retargeting) {
            if (queued.length >= MAX_QUEUED_BATCHES) return reject("upstream_unavailable");
            windowCount += events.length;
            return new Promise<LiveViewInputResult>((done) => queued.push({ events, done }));
          }
          if (ws === undefined || ws.readyState !== WS_OPEN) return reject("upstream_unavailable");
          windowCount += events.length;
          for (const event of events) ws.send(JSON.stringify(event));
          return { ok: true, accepted: events.length };
        },
        async answerDialog(answer: LiveViewDialogAnswer): Promise<LiveViewDialogResult> {
          if (closed) return { ok: false, reason: "closed" };
          if (
            !isPlainObject(answer) ||
            typeof answer.id !== "string" ||
            answer.id.length === 0 ||
            answer.id.length > MAX_DIALOG_ID ||
            typeof answer.accept !== "boolean" ||
            (answer.promptText !== undefined &&
              (typeof answer.promptText !== "string" || answer.promptText.length > MAX_DIALOG_TEXT))
          ) {
            return { ok: false, reason: "invalid" };
          }
          const open = openDialogs.get(answer.id);
          if (open === undefined || open.answered) return { ok: false, reason: "no_dialog" };
          if (!open.dialog.answerable) return { ok: false, reason: "not_answerable" };
          open.answered = true;
          const params: Record<string, unknown> = { accept: answer.accept };
          if (answer.accept && open.dialog.kind === "prompt") {
            params.promptText = answer.promptText ?? open.dialog.defaultPrompt;
          }
          const reply = await cdpCall("Page.handleJavaScriptDialog", params, open.sessionId);
          if (closed) return { ok: false, reason: "closed" };
          if (reply?.error?.code === CDP_NO_DIALOG) return { ok: false, reason: "no_dialog" };
          if (reply === undefined || reply.error !== undefined) {
            open.answered = false;
            return { ok: false, reason: "closed" };
          }
          return { ok: true };
        },
        clearFrame() {
          latest.delete("frame");
        },
        async close() {
          finish("closed");
        },
      };
    },
  };
}
