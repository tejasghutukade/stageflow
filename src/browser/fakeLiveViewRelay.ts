import type {
  LiveViewDialog,
  LiveViewDialogAnswer,
  LiveViewInputEvent,
  LiveViewMessage,
  LiveViewRelay,
  LiveViewSession,
  LiveViewSessionRequest,
  LiveViewSubscriber,
} from "./liveViewRelay.js";

export type FakeLiveViewSession = LiveViewSession & {
  /** Feeds a message as if it came from the browser's stream. */
  emit(message: LiveViewMessage): void;
  readonly input: readonly LiveViewInputEvent[];
  readonly answers: readonly LiveViewDialogAnswer[];
  readonly closed: boolean;
};

export type FakeLiveViewRelay = LiveViewRelay & {
  readonly sessions: readonly FakeLiveViewSession[];
};

const REPLAYED = ["status", "tabs", "url", "frame"] as const;
type Replayed = (typeof REPLAYED)[number];

export function createFakeLiveViewRelay(): FakeLiveViewRelay {
  const sessions: FakeLiveViewSession[] = [];
  return {
    sessions,
    async open(_request: LiveViewSessionRequest): Promise<FakeLiveViewSession> {
      const subscribers = new Set<LiveViewSubscriber>();
      const latest = new Map<Replayed, LiveViewMessage>();
      const input: LiveViewInputEvent[] = [];
      const answers: LiveViewDialogAnswer[] = [];
      const openDialogs = new Map<string, { dialog: LiveViewDialog; answered: boolean }>();
      const session: FakeLiveViewSession = {
        input,
        answers,
        closed: false,
        emit(message) {
          if (message.type === "dialog") {
            const dialog = message.data as LiveViewDialog;
            openDialogs.set(dialog.id, { dialog, answered: false });
          } else if (message.type === "dialog_closed") {
            openDialogs.delete((message.data as { id: string }).id);
          } else if (message.type !== "closed" && message.type !== "retarget") {
            latest.set(message.type, message);
          }
          for (const subscriber of subscribers) subscriber(message);
        },
        subscribe(subscriber) {
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
        async sendInput(events) {
          if (session.closed) return { ok: false, reason: "closed" };
          input.push(...events);
          return { ok: true, accepted: events.length };
        },
        async answerDialog(answer) {
          if (session.closed) return { ok: false, reason: "closed" };
          if (
            typeof answer?.id !== "string" ||
            typeof answer.accept !== "boolean" ||
            (answer.promptText !== undefined && typeof answer.promptText !== "string")
          ) {
            return { ok: false, reason: "invalid" };
          }
          const open = openDialogs.get(answer.id);
          if (open === undefined || open.answered) return { ok: false, reason: "no_dialog" };
          if (!open.dialog.answerable) return { ok: false, reason: "not_answerable" };
          open.answered = true;
          answers.push(answer);
          return { ok: true };
        },
        clearFrame() {
          latest.delete("frame");
        },
        async close() {
          if (session.closed) return;
          (session as { closed: boolean }).closed = true;
          for (const subscriber of subscribers) {
            subscriber({ type: "closed", data: { reason: "closed" } });
          }
          subscribers.clear();
          openDialogs.clear();
        },
      };
      sessions.push(session);
      return session;
    },
  };
}
