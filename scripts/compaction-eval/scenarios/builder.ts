import type { FactPosition, PlantedFact, Probe, Scenario, ScenarioMessage } from "../types.js";

export type Rng = {
  next(): number;
  int(lo: number, hi: number): number;
  pick<T>(items: readonly T[]): T;
  hex(length: number): string;
};

export function rng(seed: number): Rng {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: (items) => items[Math.floor(next() * items.length)]!,
    hex: (length) => {
      let out = "";
      while (out.length < length) out += Math.floor(next() * 16).toString(16);
      return out;
    },
  };
}

const WORDS = (
  "alpha ledger queue retry window snapshot pipeline shard replica cache lookup token budget review " +
  "release cluster schema merge stable patch rollout metric trace sample batch quota region upstream " +
  "latency handler worker config module bundle signal resolve commit branch deploy canary baseline " +
  "report ticket owner policy notice summary account invoice payment gateway session profile import export"
).split(" ");

export function sentence(r: Rng): string {
  const n = r.int(8, 18);
  const words: string[] = [];
  for (let i = 0; i < n; i++) words.push(r.pick(WORDS));
  const text = words.join(" ");
  return text[0]!.toUpperCase() + text.slice(1) + ".";
}

export function paragraph(r: Rng, chars: number): string {
  let out = "";
  while (out.length < chars) out += (out ? " " : "") + sentence(r);
  return out;
}

export function isoTime(ms: number): string {
  return new Date(ms).toISOString().replace(".000Z", "Z");
}

/** Builds `chars` characters of noise lines, then splices `inject` lines in at fractional positions. */
export function fill(
  chars: number,
  make: (index: number) => string,
  inject: ReadonlyArray<readonly [number, string]> = [],
): string {
  const lines: string[] = [];
  let length = 0;
  for (let i = 0; length < chars; i++) {
    const line = make(i);
    lines.push(line);
    length += line.length + 1;
  }
  const base = lines.length;
  const sorted = [...inject].sort((a, b) => a[0] - b[0]);
  sorted.forEach(([fraction, line], offset) => {
    lines.splice(Math.floor(fraction * base) + offset, 0, line);
  });
  return lines.join("\n");
}

export function messageText(message: ScenarioMessage): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content as Array<Record<string, unknown>>) {
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
    else if (block.type === "thinking" && typeof block.thinking === "string") parts.push(block.thinking);
    else if (block.type === "toolCall") parts.push(`${String(block.name)} ${JSON.stringify(block.arguments ?? {})}`);
  }
  return parts.join("\n");
}

export function transcriptText(messages: readonly ScenarioMessage[]): string {
  return messages.map(messageText).join("\n");
}

export function matchesText(pattern: string | RegExp, text: string): boolean {
  if (typeof pattern === "string") return text.includes(pattern);
  return new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, "")).test(text);
}

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export class Transcript {
  readonly messages: ScenarioMessage[] = [];
  private clock = Date.UTC(2026, 2, 14, 2, 0, 0);

  constructor(readonly r: Rng) {}

  private tick(): number {
    this.clock += this.r.int(800, 9000);
    return this.clock;
  }

  user(text: string): void {
    this.messages.push({ role: "user", content: [{ type: "text", text }], timestamp: this.tick() });
  }

  say(text: string): void {
    this.messages.push(this.assistant([{ type: "text", text }], "stop"));
  }

  call(name: string, args: Record<string, unknown>, result: string, options: { isError?: boolean; say?: string } = {}): void {
    const id = `call_${this.r.hex(6)}`;
    const content: Array<Record<string, unknown>> = [];
    if (options.say) content.push({ type: "text", text: options.say });
    content.push({ type: "toolCall", id, name, arguments: args });
    this.messages.push(this.assistant(content, "toolUse"));
    this.messages.push({
      role: "toolResult",
      toolCallId: id,
      toolName: name,
      content: [{ type: "text", text: result }],
      isError: options.isError ?? false,
      timestamp: this.tick(),
    });
  }

  private assistant(content: Array<Record<string, unknown>>, stopReason: string): ScenarioMessage {
    return {
      role: "assistant",
      content,
      api: "openai-completions",
      provider: "scenario",
      model: "scenario-model",
      usage: ZERO_USAGE,
      stopReason,
      timestamp: this.tick(),
    };
  }
}

export type ScenarioSpec = {
  id: string;
  family: string;
  description: string;
  transcript: Transcript;
  keepTail: number;
  facts: PlantedFact[];
  probes: Probe[];
  secrets?: string[];
};

function bucket(index: number, region: number): FactPosition {
  const fraction = index / region;
  if (fraction < 1 / 3) return "early";
  if (fraction < 2 / 3) return "mid";
  return "late";
}

export function buildScenario(spec: ScenarioSpec): Scenario {
  const messages = spec.transcript.messages;
  const region = messages.length - spec.keepTail;
  const texts = messages.map(messageText);
  for (const fact of spec.facts) {
    const index = texts.findIndex((text) => matchesText(fact.mustContain, text));
    if (index < 0) throw new Error(`${spec.id}: fact ${fact.id} is not in the transcript`);
    if (index >= region) throw new Error(`${spec.id}: fact ${fact.id} sits in the kept tail (message ${index})`);
    const actual = bucket(index, region);
    if (actual !== fact.where) throw new Error(`${spec.id}: fact ${fact.id} declared ${fact.where} but is ${actual} (message ${index} of ${region})`);
  }
  const ids = new Set(spec.facts.map((fact) => fact.id));
  for (const probe of spec.probes) {
    for (const id of probe.factIds) if (!ids.has(id)) throw new Error(`${spec.id}: probe references unknown fact ${id}`);
  }
  const all = texts.join("\n");
  for (const secret of spec.secrets ?? []) {
    if (!all.includes(secret)) throw new Error(`${spec.id}: secret is not in the transcript`);
  }
  return {
    id: spec.id,
    family: spec.family,
    description: spec.description,
    messages,
    keepTail: spec.keepTail,
    facts: spec.facts,
    probes: spec.probes,
    secrets: spec.secrets ?? [],
  };
}
