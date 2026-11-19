import type { EvalConsumerHandle } from "./evalConsumerSession.js";

export class EvalConsumerRegistry {
  private readonly bySession = new Map<string, EvalConsumerHandle>();

  set(sessionId: string, handle: EvalConsumerHandle): void {
    const prior = this.bySession.get(sessionId);
    if (prior && prior !== handle) prior.close();
    this.bySession.set(sessionId, handle);
  }

  get(sessionId: string): EvalConsumerHandle | undefined {
    return this.bySession.get(sessionId);
  }

  delete(sessionId: string): void {
    const handle = this.bySession.get(sessionId);
    if (handle) {
      handle.close();
      this.bySession.delete(sessionId);
    }
  }

  clear(): void {
    for (const id of [...this.bySession.keys()]) this.delete(id);
  }
}