import { createHash, randomBytes } from "node:crypto";
import type { EvalPlan, RunCaseRequest, RunCaseResult } from "../../types.js";

export type RunCaseHandler = (req: RunCaseRequest) => Promise<RunCaseResult>;

export type RunTokenBinding = {
  plan?: EvalPlan;
  runCase?: RunCaseHandler;
};

export type RunTokenEntry = { evalRunId: string; binding: RunTokenBinding };

function digest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export class RunTokenRegistry {
  private readonly byDigest = new Map<string, RunTokenEntry>();
  private readonly byRun = new Map<string, string>();

  issue(evalRunId: string, binding: RunTokenBinding = {}): string {
    this.revoke(evalRunId);
    const token = randomBytes(32).toString("base64url");
    const key = digest(token);
    this.byDigest.set(key, { evalRunId, binding });
    this.byRun.set(evalRunId, key);
    return token;
  }

  verify(token: string | undefined): RunTokenEntry | undefined {
    if (token === undefined || token.length === 0) return undefined;
    return this.byDigest.get(digest(token));
  }

  revoke(evalRunId: string): void {
    const key = this.byRun.get(evalRunId);
    if (key === undefined) return;
    this.byRun.delete(evalRunId);
    this.byDigest.delete(key);
  }

  has(evalRunId: string): boolean {
    return this.byRun.has(evalRunId);
  }
}
