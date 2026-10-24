import { SimulatorError, type DriverUsage, type SimulatorModel } from "./simulatorModel.js";
import { renderSimulatorPrompt, SIMULATOR_LIMITS } from "./simulatorPrompt.js";

export type { DriverUsage };

export type DriverMode = "script" | "simulated";

export type DriverScenario = {
  mode?: DriverMode;
  script?: readonly string[];
  opening?: string;
  persona?: string;
  goal?: string;
  facts?: readonly string[];
};

export type DriverContext = {
  turn: number;
  transcript: Array<{ role: "user" | "assistant"; text: string }>;
  signal: AbortSignal;
};

export type DriverEndReason = "script_end" | "resolved" | "abandoned" | "no_progress" | "empty_message";

export type DriverStep =
  | { kind: "message"; text: string; endAfter?: "resolved" | "abandoned"; usage?: DriverUsage }
  | { kind: "end"; reason: DriverEndReason; usage?: DriverUsage };

export interface UserDriver {
  next(ctx: DriverContext): Promise<DriverStep>;
}

export class DriverScenarioError extends Error {
  readonly code = "EVAL_INVALID";
  constructor(message: string) {
    super(message);
    this.name = "DriverScenarioError";
  }
}

export const SCRIPT_LIMITS = { minMessages: 1, maxMessages: 40 } as const;

export class ScriptDriver implements UserDriver {
  constructor(private readonly script: readonly string[]) {}

  async next(ctx: DriverContext): Promise<DriverStep> {
    const text = this.script[ctx.turn - 1];
    return text === undefined ? { kind: "end", reason: "script_end" } : { kind: "message", text };
  }
}

const END_MARKER = /\[\[END:(resolved|abandoned)\]\]/g;
const LAST_LINE_MARKER = /^\[\[END:(resolved|abandoned)\]\]$/;

export function parseSimulatorReply(raw: string): { text: string; end?: "resolved" | "abandoned" } {
  const lines = raw.trim().split(/\r?\n/);
  let end: "resolved" | "abandoned" | undefined;
  const last = lines[lines.length - 1]?.trim() ?? "";
  const match = LAST_LINE_MARKER.exec(last);
  if (match) {
    end = match[1] as "resolved" | "abandoned";
    lines.pop();
  }
  const text = lines.join("\n").replace(END_MARKER, "").trim();
  return end === undefined ? { text } : { text, end };
}

export class SimulatedUser implements UserDriver {
  private readonly scenario: Required<Pick<DriverScenario, "opening" | "persona" | "goal">> & { facts: readonly string[] };
  private readonly model: SimulatorModel;
  private readonly maxHistoryTurns: number;
  private readonly maxMessageChars: number;

  constructor(options: {
    scenario: DriverScenario;
    model: SimulatorModel;
    maxHistoryTurns?: number;
    maxMessageChars?: number;
  }) {
    const { opening, persona, goal } = options.scenario;
    if (!opening || !persona || !goal) {
      throw new DriverScenarioError("A simulated scenario needs opening, persona and goal.");
    }
    this.scenario = { opening, persona, goal, facts: options.scenario.facts ?? [] };
    this.model = options.model;
    this.maxHistoryTurns = options.maxHistoryTurns ?? SIMULATOR_LIMITS.maxHistoryTurns;
    this.maxMessageChars = options.maxMessageChars ?? SIMULATOR_LIMITS.maxMessageChars;
  }

  async next(ctx: DriverContext): Promise<DriverStep> {
    if (ctx.turn <= 1) return { kind: "message", text: this.scenario.opening };
    const { system, user } = renderSimulatorPrompt({
      persona: this.scenario.persona,
      goal: this.scenario.goal,
      facts: this.scenario.facts,
      transcript: ctx.transcript,
      limits: { maxHistoryTurns: this.maxHistoryTurns, maxMessageChars: this.maxMessageChars },
    });
    let reply;
    try {
      reply = await this.model.complete({ system, user, signal: ctx.signal });
    } catch (error) {
      if (ctx.signal.aborted || error instanceof SimulatorError) throw error;
      throw new SimulatorError();
    }
    const usage = reply.usage;
    const parsed = parseSimulatorReply(reply.text);
    const text = parsed.text.length > SIMULATOR_LIMITS.maxReplyChars ? parsed.text.slice(0, SIMULATOR_LIMITS.maxReplyChars) : parsed.text;
    const withUsage = usage === undefined ? {} : { usage };
    if (text.length === 0) {
      return parsed.end === undefined
        ? { kind: "end", reason: "empty_message", ...withUsage }
        : { kind: "end", reason: parsed.end, ...withUsage };
    }
    const previous = [...ctx.transcript].reverse().find((entry) => entry.role === "user")?.text;
    if (previous !== undefined && previous.trim().toLowerCase() === text.trim().toLowerCase()) {
      return { kind: "end", reason: "no_progress", ...withUsage };
    }
    return parsed.end === undefined
      ? { kind: "message", text, ...withUsage }
      : { kind: "message", text, endAfter: parsed.end, ...withUsage };
  }
}

export type DriverDeps = { simulatorModel?: SimulatorModel; limits?: { maxHistoryTurns?: number; maxMessageChars?: number } };

export function createDriver(mode: DriverMode, scenario: DriverScenario, deps: DriverDeps = {}): UserDriver {
  if (mode === "script") {
    const script = scenario.script;
    if (!Array.isArray(script) || script.length < SCRIPT_LIMITS.minMessages || script.length > SCRIPT_LIMITS.maxMessages) {
      throw new DriverScenarioError(`A scripted scenario needs ${SCRIPT_LIMITS.minMessages}-${SCRIPT_LIMITS.maxMessages} messages.`);
    }
    if (script.some((message) => typeof message !== "string" || message.trim().length === 0)) {
      throw new DriverScenarioError("A scripted scenario cannot contain an empty message.");
    }
    return new ScriptDriver(script);
  }
  if (mode === "simulated") {
    if (deps.simulatorModel === undefined) throw new DriverScenarioError("A simulated scenario needs a simulator model.");
    return new SimulatedUser({ scenario, model: deps.simulatorModel, ...deps.limits });
  }
  throw new DriverScenarioError(`Unknown conversation mode "${String(mode)}".`);
}
