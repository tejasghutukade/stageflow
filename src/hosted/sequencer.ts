import { redactString } from "../logging/redact.js";
import { HostedRuntimeError } from "./errors.js";
import {
  HOSTED_EVENT_SCHEMA_VERSION,
  type HostedEventBody,
  type HostedEventSink,
  type HostedRunContext,
  type HostedRunEvent,
} from "./types.js";

type Held = {
  body: HostedEventBody;
  resolve: () => void;
  reject: (error: unknown) => void;
};

export class HostedEventSequencer {
  private chain: Promise<void> = Promise.resolve();
  private held: Held[] = [];
  private holding = true;
  private sequence = 0;
  private runId = "";
  failed = false;
  failure?: { eventType: string; sequence: number; message: string };

  constructor(
    private readonly sink: HostedEventSink,
    private readonly context: HostedRunContext,
    private readonly timeoutMs: number,
    private readonly attempts: number,
  ) {}

  setRunId(runId: string): void {
    this.runId = runId;
  }

  emit(body: HostedEventBody): Promise<void> {
    if (this.failed) return Promise.reject(this.failureError());
    if (this.holding) {
      return new Promise((resolve, reject) => {
        this.held.push({ body, resolve, reject });
      });
    }
    return this.enqueue(body);
  }

  emitNow(body: HostedEventBody): Promise<void> {
    if (this.failed) return Promise.reject(this.failureError());
    return this.enqueue(body);
  }

  release(): void {
    if (!this.holding) return;
    this.holding = false;
    const queued = this.held;
    this.held = [];
    for (const item of queued) {
      const run = this.chain.then(() => this.deliver(item.body));
      this.chain = run.then(
        () => undefined,
        () => undefined,
      );
      void run.then(item.resolve, item.reject);
    }
  }

  rejectHeld(error: unknown): void {
    this.holding = false;
    const queued = this.held;
    this.held = [];
    for (const item of queued) item.reject(error);
  }

  private enqueue(body: HostedEventBody): Promise<void> {
    const run = this.chain.then(() => this.deliver(body));
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async deliver(body: HostedEventBody): Promise<void> {
    if (this.failed) throw this.failureError();
    const sequence = ++this.sequence;
    const event = this.envelope(body, sequence);
    let last: unknown;
    for (let attempt = 1; attempt <= this.attempts; attempt += 1) {
      try {
        await withTimeout(this.sink.onEvent(event), this.timeoutMs);
        return;
      } catch (error) {
        last = error;
      }
    }
    const message = redactString(errorMessage(last));
    this.failed = true;
    this.failure = { eventType: event.type, sequence, message };
    throw this.failureError();
  }

  private envelope(body: HostedEventBody, sequence: number): HostedRunEvent {
    return {
      schemaVersion: HOSTED_EVENT_SCHEMA_VERSION,
      eventId: `${this.context.externalAttemptId}:${sequence}`,
      sequence,
      occurredAt: new Date().toISOString(),
      runId: this.runId,
      externalRunId: this.context.externalRunId,
      externalAttemptId: this.context.externalAttemptId,
      packageRevision: this.context.packageRevision,
      ...(this.context.attributes !== undefined
        ? { attributes: this.context.attributes }
        : {}),
      ...body,
    } as HostedRunEvent;
  }

  private failureError(): HostedRuntimeError {
    const failure = this.failure;
    return new HostedRuntimeError(
      failure?.message ?? "hosted event sink failed",
      {
        code: "event_sink_failed",
        externalRunId: this.context.externalRunId,
        externalAttemptId: this.context.externalAttemptId,
        ...(this.runId !== "" ? { runId: this.runId } : {}),
        ...(failure !== undefined
          ? { eventType: failure.eventType, sequence: failure.sequence }
          : {}),
      },
    );
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function withTimeout(work: Promise<void>, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("hosted event sink timed out"));
    }, timeoutMs);
    work.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
