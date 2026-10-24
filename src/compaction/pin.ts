import { redactString } from "../logging/redact.js";
import type { PinnedFact, PinnedFactKind } from "./types.js";

/** Minimal message shape (Pi session messages); only role and content are read. */
export type LooseMessage = { role?: unknown; content?: unknown; toolName?: unknown; [key: string]: unknown };

export type RankedPinnedFact = PinnedFact & { count: number; score: number };

export type ExtractPinnedOptions = {
  maxFactsPerMessage?: number;
  maxFacts?: number;
  maxLinesPerMessage?: number;
  maxLineChars?: number;
  noiseThreshold?: number;
};

const DEFAULTS = {
  maxFactsPerMessage: 300,
  maxFacts: 1500,
  maxLinesPerMessage: 20_000,
  maxLineChars: 2000,
  noiseThreshold: 20,
};

const MAX_VALUE_CHARS = 200;
const MAX_CONTEXT_CHARS = 140;
const MAX_FACTS_PER_LINE = 12;

const BASE_SCORE: Record<PinnedFactKind, number> = {
  error: 100,
  id: 60,
  number: 40,
  url: 35,
  timestamp: 28,
  path: 26,
  other: 18,
};

const KIND_ORDER: PinnedFactKind[] = ["error", "id", "number", "timestamp", "url", "path", "other"];
const KIND_TITLE: Record<PinnedFactKind, string> = {
  error: "Errors",
  id: "Identifiers",
  number: "Numbers",
  timestamp: "Timestamps",
  url: "URLs",
  path: "Paths",
  other: "Other",
};

const ERROR_RE =
  /\b(?:errors?|fail(?:ed|s|ure|ures|ing)?|exceptions?|denied|time[d ]?-?outs?|fatal|panic|traceback|refused|unauthori[sz]ed|forbidden|exit(?:ed)?(?: with)? (?:code|status):? ?[1-9]\d*|exit code:? ?[1-9]\d*|status:? ?[45]\d\d|HTTP\/\d(?:\.\d)? [45]\d\d|\b[45]\d\d (?:error|bad|not|internal|service|gateway|forbidden|unauthorized))\b/i;

const URL_RE = /https?:\/\/[^\s"'<>`)\]},]+/g;
const ISO_TS_RE = /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g;
const TIME_RE = /(?<![\d:.])\d{1,2}:\d{2}(?::\d{2})?\s?(?:[AP]M|UTC|GMT)\b|(?<![\d:.\-T])\d{2}:\d{2}:\d{2}(?:\.\d+)?(?![\d:])/gi;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const TICKET_RE = /\b[A-Z][A-Z0-9]{1,9}-\d{1,7}\b/g;
const TICKET_STOP = new Set(["UTF", "SHA", "ISO", "MD", "AES", "RSA", "HTTP", "TLS", "SSL", "CVE", "RFC", "X", "IPV", "TCP", "UDP", "SSE", "GPT", "COVID"]);
const PR_RE = /\b(?:PR|pull request|pull|issue|MR)\s*#?\d{1,7}\b|(?<![\w&/#])#\d{2,7}\b/gi;
const HASH_RE = /\b(?:build|commit|sha\d*|rev|revision|hash|digest|checksum|image|release|tag)\b[^\n]{0,24}?\b([0-9a-f]{7,40})\b/gi;
const PATH_ABS_RE = /(?<![\w:/.])\/(?:[\w.@+~-]+\/)+[\w.@+~-]+/g;
const PATH_REL_RE = /(?<![\w:/.@])(?:\.{1,2}\/)?(?:[\w.@+~-]+\/)+[\w.@+~-]*\.[A-Za-z0-9]{1,8}\b/g;
const KV_EQ_RE = /\b([A-Za-z_][\w.-]{1,40})=("[^"\n]{1,80}"|'[^'\n]{1,80}'|[^\s,;&)}\]"']{1,80})/g;
const KV_JSON_RE = /"([A-Za-z_][\w.-]{1,40})"\s*:\s*("[^"\n]{1,80}"|-?\d[\d.eE+-]*|true|false|null)/g;
const KV_COLON_NUM_RE = /\b([A-Za-z_][\w.-]{1,40}):\s+(-?\d[\d,]*(?:\.\d+)?%?)(?![\d:])/g;
const UNIT_RE =
  /(?<![\w.:-])\d[\d,]*(?:\.\d+)?\s?(?:ms|sec|secs|seconds|minutes|mins|hours|days|KB|MB|GB|TB|bytes|requests|reqs|errors|failures|users|orders|rows|records|retries|events|messages|items|files|tests|connections|jobs|calls|shards)\b/gi;
const CURRENCY_RE = /(?<![\w])[$€£]\s?\d[\d,]*(?:\.\d+)?(?:[kKmMbB]\b)?|\b\d[\d,]*(?:\.\d+)?\s?(?:USD|EUR|GBP)\b/g;
const PERCENT_RE = /(?<![\w.])\d+(?:\.\d+)?%/g;
const ID_KEY_RE = /(?:^|[_.-])(?:id|uuid|key|ref|no|number|num|sha|hash|rev|build|ticket|incident|order|user|account|customer|request|trace)$/i;
const SECRET_KEY_RE = /secret|token|passw|pwd|api[_-]?key|auth|credential|bearer|cookie|private|session|\bsid\b|csrf|xsrf|jwt|signature/i;
const EXTRA_SECRET_RES: RegExp[] = [
  /\b(?:api[_-]?key|secret|token|password|passwd|authorization|bearer)\b["']?\s*[:=]\s*["']?[^\s"',;]+/gi,
  /\bBearer\s+[A-Za-z0-9\-._~+/]{8,}=*/gi,
  /\b(?:Set-)?Cookie:[^\n]*/gi,
  /\b(?:session|sess|sid|csrf|xsrf|jsessionid|phpsessid)[\w-]*=[^\s;,"']+/gi,
  /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abprs]-[\w-]{8,}/g,
  /\b(?:sk|pk|rk)[-_](?:live|test|proj|ant)?[-_]?[A-Za-z0-9_-]{16,}/g,
  /[?&](?:token|key|api_?key|access_token|auth|signature|sig)=[^\s&"']+/gi,
];

export function scrubSecrets(text: string): string {
  let out = redactString(text);
  for (const re of EXTRA_SECRET_RES) {
    re.lastIndex = 0;
    out = out.replace(re, "[redacted]");
  }
  return out;
}

function messageText(message: LooseMessage): string | undefined {
  const role = message.role;
  if (role !== "user" && role !== "toolResult") return undefined;
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const block of content) {
    if (block !== null && typeof block === "object" && (block as { type?: unknown }).type === "text") {
      const text = (block as { text?: unknown }).text;
      if (typeof text === "string") parts.push(text);
    }
  }
  return parts.join("\n");
}

function lineTemplate(line: string): string {
  return line
    .replace(/\b[0-9a-f]{6,}\b/gi, "#")
    .replace(/\d+/g, "#")
    .replace(/"[^"]*"/g, '"#"')
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
}

function singleLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function contextAround(line: string, index: number, length: number): string {
  const flat = line.length > 400 ? line.slice(Math.max(0, index - 200), index + length + 200) : line;
  const offset = line.length > 400 ? Math.min(index, 200) : index;
  const start = Math.max(0, offset - 50);
  const end = Math.min(flat.length, offset + length + 60);
  let out = singleLine(flat.slice(start, end));
  if (out.length > MAX_CONTEXT_CHARS) out = out.slice(0, MAX_CONTEXT_CHARS);
  return out;
}

type Candidate = { kind: PinnedFactKind; value: string; index: number; weight?: number };

function numericLike(value: string): boolean {
  return /^-?\d[\d,]*(?:\.\d+)?(?:[eE][+-]?\d+)?%?$/.test(value);
}

function collectCandidates(line: string, isErrorLine: boolean, keyFreq: Map<string, number>, noiseThreshold: number): Candidate[] {
  const out: Candidate[] = [];
  const claimed: Array<[number, number]> = [];
  const free = (start: number, end: number) => !claimed.some(([s, e]) => start < e && end > s);
  const claim = (start: number, end: number) => claimed.push([start, end]);
  const run = (re: RegExp, on: (m: RegExpExecArray) => Candidate | undefined, takeSpan = true) => {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    let guard = 0;
    while ((m = re.exec(line)) !== null && guard++ < 50) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      const start = m.index;
      const end = start + m[0].length;
      if (!free(start, end)) continue;
      const cand = on(m);
      if (cand) {
        out.push(cand);
        if (takeSpan) claim(start, end);
      }
    }
  };

  run(URL_RE, (m) => ({ kind: "url", value: m[0].replace(/[.;:!?]+$/, ""), index: m.index }));
  run(ISO_TS_RE, (m) => ({ kind: "timestamp", value: m[0], index: m.index }));
  run(UUID_RE, (m) => ({ kind: "id", value: m[0], index: m.index }));
  run(PR_RE, (m) => ({ kind: "id", value: m[0].replace(/\s+/g, " "), index: m.index }));
  run(TICKET_RE, (m) => {
    const prefix = m[0].slice(0, m[0].indexOf("-"));
    if (TICKET_STOP.has(prefix)) return undefined;
    return { kind: "id", value: m[0], index: m.index };
  });
  run(
    HASH_RE,
    (m) => {
      const hex = m[1]!;
      if (!/\d/.test(hex) || !/[a-f]/i.test(hex)) return undefined;
      return { kind: "id", value: hex, index: m.index + m[0].length - hex.length };
    },
    false,
  );
  run(TIME_RE, (m) => ({ kind: "timestamp", value: m[0].trim(), index: m.index }));
  run(PATH_ABS_RE, (m) => (m[0].length >= 5 ? { kind: "path", value: m[0], index: m.index } : undefined));
  run(PATH_REL_RE, (m) => ({ kind: "path", value: m[0], index: m.index }));

  const kv = (key: string, raw: string, index: number): Candidate | undefined => {
    if (SECRET_KEY_RE.test(key)) return undefined;
    const value = raw.replace(/^["']|["']$/g, "");
    if (value.length === 0 || value === "null" || value === "true" || value === "false") return undefined;
    const common = (keyFreq.get(key) ?? 0) > noiseThreshold;
    const numeric = numericLike(value);
    const kind: PinnedFactKind = ID_KEY_RE.test(key) && !numeric ? "id" : ID_KEY_RE.test(key) ? "id" : numeric ? "number" : "other";
    return { kind, value: `${key}=${value}`, index, weight: common ? -25 : 0 };
  };
  run(KV_EQ_RE, (m) => kv(m[1]!, m[2]!, m.index));
  run(KV_JSON_RE, (m) => kv(m[1]!, m[2]!, m.index));
  run(KV_COLON_NUM_RE, (m) => kv(m[1]!, m[2]!, m.index));
  run(CURRENCY_RE, (m) => ({ kind: "number", value: m[0].trim(), index: m.index }));
  run(PERCENT_RE, (m) => ({ kind: "number", value: m[0], index: m.index }));
  run(UNIT_RE, (m) => ({ kind: "number", value: m[0].trim(), index: m.index }));

  if (isErrorLine) {
    const value = singleLine(line);
    out.push({ kind: "error", value: value.length > MAX_VALUE_CHARS ? value.slice(0, MAX_VALUE_CHARS) : value, index: 0 });
  }
  return out.slice(0, MAX_FACTS_PER_LINE + (isErrorLine ? 1 : 0));
}

export function extractPinnedFacts(messages: readonly LooseMessage[], options: ExtractPinnedOptions = {}): RankedPinnedFact[] {
  const cfg = { ...DEFAULTS, ...options };
  const facts = new Map<string, RankedPinnedFact & { order: number }>();
  let order = 0;

  messages.forEach((message, messageIndex) => {
    const text = messageText(message);
    if (!text) return;
    const isUser = message.role === "user";
    const toolName = !isUser && typeof message.toolName === "string" ? message.toolName : undefined;
    const lines = text.split("\n", cfg.maxLinesPerMessage + 1).slice(0, cfg.maxLinesPerMessage);

    const templates = new Map<string, number>();
    const keyFreq = new Map<string, number>();
    const trimmed: string[] = [];
    for (const raw of lines) {
      const line = raw.length > cfg.maxLineChars ? raw.slice(0, cfg.maxLineChars) : raw;
      trimmed.push(line);
      if (line.trim().length === 0) continue;
      const tpl = lineTemplate(line);
      templates.set(tpl, (templates.get(tpl) ?? 0) + 1);
      if (!isUser) {
        KV_EQ_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        let g = 0;
        while ((m = KV_EQ_RE.exec(line)) !== null && g++ < 8) keyFreq.set(m[1]!, (keyFreq.get(m[1]!) ?? 0) + 1);
      }
    }

    let messageFacts = 0;
    for (const line of trimmed) {
      if (messageFacts >= cfg.maxFactsPerMessage) break;
      if (line.trim().length === 0) continue;
      const errorLine = ERROR_RE.test(line);
      const repeats = templates.get(lineTemplate(line)) ?? 1;
      if (!isUser && !errorLine && repeats > cfg.noiseThreshold) continue;
      const rarity = errorLine ? 0 : repeats > 1 ? -Math.min(15, Math.log2(repeats) * 3) : 0;
      for (const cand of collectCandidates(line, errorLine, keyFreq, cfg.noiseThreshold)) {
        const value = cand.value.length > MAX_VALUE_CHARS ? cand.value.slice(0, MAX_VALUE_CHARS) : cand.value;
        if (scrubSecrets(value) !== value) continue;
        const key = `${cand.kind}\u0000${value}`;
        const existing = facts.get(key);
        if (existing) {
          existing.count++;
          continue;
        }
        if (facts.size >= cfg.maxFacts * 2) continue;
        const context = scrubSecrets(contextAround(line, cand.index, value.length));
        const score = BASE_SCORE[cand.kind] + (isUser ? 15 : 0) + rarity + (cand.weight ?? 0);
        facts.set(key, {
          kind: cand.kind,
          value,
          context,
          source: toolName ? { messageIndex, toolName } : { messageIndex },
          count: 1,
          score,
          order: order++,
        });
        messageFacts++;
      }
    }
  });

  const ranked = [...facts.values()].map((fact) => ({
    ...fact,
    score: fact.score - Math.min(12, Math.log2(fact.count) * 3),
  }));
  ranked.sort((a, b) => b.score - a.score || a.order - b.order);
  return ranked.slice(0, cfg.maxFacts).map(({ order: _order, ...fact }) => fact);
}

export function renderPinned(facts: readonly PinnedFact[], maxChars: number): string {
  const title = "## Pinned facts";
  const omittedLine = (n: number) => `- (${n} more omitted)`;
  const base = `${title}\n${omittedLine(facts.length)}`;
  if (maxChars < base.length) return base.slice(0, Math.max(0, maxChars)).replace(/\n[^\n]*$/, "").slice(0, Math.max(0, maxChars));

  const chosen = new Map<PinnedFactKind, string[]>();
  let used = title.length + 1;
  let included = 0;
  const reserve = omittedLine(facts.length).length + 1;
  for (const fact of facts) {
    const value = singleLine(scrubSecrets(fact.value));
    const context = singleLine(scrubSecrets(fact.context));
    if (value.length === 0) continue;
    const line = context.length > 0 && context !== value ? `- ${value} — ${context}` : `- ${value}`;
    const headerCost = chosen.has(fact.kind) ? 0 : `### ${KIND_TITLE[fact.kind]}`.length + 1;
    const cost = headerCost + line.length + 1;
    if (used + cost + reserve > maxChars) continue;
    const bucket = chosen.get(fact.kind) ?? [];
    bucket.push(line);
    chosen.set(fact.kind, bucket);
    used += cost;
    included++;
  }

  const out = [title];
  for (const kind of KIND_ORDER) {
    const bucket = chosen.get(kind);
    if (!bucket) continue;
    out.push(`### ${KIND_TITLE[kind]}`, ...bucket);
  }
  out.push(omittedLine(facts.length - included));
  return out.join("\n");
}
