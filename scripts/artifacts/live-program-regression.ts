import "../../src/artifacts/library/telemetryEnv.js";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LIBRARY_NAME, LIBRARY_VERSION, vocabularyPrompt } from "../../src/artifacts/library/index.js";
import { liveArtifactsPromptSection } from "../../src/artifacts/livePrompt.js";
import { reconcileProgram, validateProgram } from "../../src/artifacts/program.js";

const args = process.argv.slice(2);
function flag(name: string, fallback = ""): string {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  return args[index + 1] ?? fallback;
}

const dryRun = args.includes("--dry-run");
const keyFile = flag("--key-file");
const outDir = path.resolve(flag("--out-dir", path.join(tmpdir(), "stageflow-live-regression")));
const model = flag("--model", "anthropic/claude-haiku-4.5");
const maxUsd = Number(flag("--max-usd", "0.5"));
const dryCallUsd = Number(flag("--dry-call-usd", "0.001"));

if (!dryRun && !keyFile) {
  console.error("missing --key-file");
  process.exit(2);
}

let apiKey = "";
if (!dryRun) {
  apiKey = (await readFile(keyFile, "utf8")).trim();
  if (!apiKey) {
    console.error("key file is empty");
    process.exit(2);
  }
}

const outputSchema = {
  type: "object",
  properties: {
    rows: {
      type: "array",
      items: {
        type: "object",
        properties: { day: { type: "string" }, events: { type: "number" } },
      },
    },
  },
};

const systemPrompt = liveArtifactsPromptSection([
  {
    id: "get_usage",
    description: "Event counts by day. range is 7 or 30.",
    input: "{range: string}",
    output: "rows[].day, rows[].events",
  },
]);

const kpiProgram = `header = CardHeader("Weekly revenue", "Last 7 days")
stat = Stat("Revenue", "$48,250", "ok")
delta = TextContent("+9.4% vs last week")
root = Stack([header, stat, delta], "column", "m")`;

const tableProgram = `header = CardHeader("Open tickets", "Sorted by age")
table = Table([
  Col("ID", ["T-1042", "T-1048", "T-1101", "T-1108"]),
  Col("Title", ["Checkout timeout", "Invoice blank", "SSO loop", "Webhook drift"]),
  Col("Status", ["needs", "running", "fail", "queued"]),
  Col("Owner", ["Mina", "Jules", "Ari", "Sam"])
])
root = Stack([header, table], "column", "m")`;

const barProgram = `header = CardHeader("Signups by channel", "This week")
chart = BarChart(["Organic", "Paid", "Referral", "Email"], [Series("Signups", [420, 310, 180, 95])], null, "Channel", "Signups", 240)
root = Stack([header, chart], "column", "m")`;

const brokenBar = `header = CardHeader("Signups by channel", "This week")
chart = BarChart("Organic", [Series("Signups", [420, 310, 180, 95])])
root = Stack([header, chart], "column", "m")`;

const lineProgram = `$range = "7"
usage = Query("get_usage", {range: $range}, {rows: []}, 3)
filter = Select("range", [SelectItem("7", "7 days"), SelectItem("30", "30 days")], "Range", null, $range)
header = CardHeader("Usage", "Events")
chart = LineChart(usage.rows.day, [Series("Events", usage.rows.events)], null, "Day", "Events", 240)
root = Stack([header, filter, chart], "column", "m")`;

const formProgram = `$note = ""
$score = "good"
note = Input("note", "What should we change?", "text", null, $note)
score = Select("score", [SelectItem("good", "Good"), SelectItem("ok", "Okay"), SelectItem("bad", "Bad")], "Score", null, $score)
submit = Button("Send feedback", null, "primary")
root = Stack([CardHeader("Feedback", "Stage review"), note, score, submit], "column", "m")`;

const tasks = [
  { id: "kpi", task: "A KPI card for weekly revenue, with the dollar amount and the change versus last week.", canned: kpiProgram, broken: false },
  { id: "table", task: "A sortable-looking table of open tickets with id, title, status, and owner.", canned: tableProgram, broken: false },
  { id: "bar", task: "A bar chart of signups by channel: Organic, Paid, Referral, and Email.", canned: barProgram, broken: true },
  { id: "line", task: "A line chart of events with a 7-day and 30-day filter bound to a Query tool named get_usage.", canned: lineProgram, broken: false },
  { id: "form", task: "A small feedback form with a note, a score, and a submit button.", canned: formProgram, broken: false },
];

function extractProgram(text: string): string {
  const fence = text.match(/```(?:openui|text)?\n([\s\S]*?)```/);
  const body = fence ? fence[1]! : text;
  return body
    .split("\n")
    .filter((line) => line.trim() && !line.trim().startsWith("```"))
    .join("\n")
    .trim();
}

function scrub(text: string): string {
  if (!apiKey) return text;
  return text.split(apiKey).join("[redacted]");
}

function check(program: string) {
  const parsed = validateProgram(program);
  const reconciled = reconcileProgram(
    program,
    [{ id: "usage", function: "get_usage", args: { range: "7" } }],
    new Map([["get_usage", { outputSchema }]]),
  );
  const errors = [...parsed.errors, ...reconciled.errors];
  return { ok: errors.length === 0, errors, warnings: [...parsed.warnings, ...reconciled.warnings] };
}

let price: { prompt: number; completion: number } | null = null;
async function loadPrice(): Promise<typeof price> {
  if (dryRun || price) return price;
  const res = await fetch("https://openrouter.ai/api/v1/models");
  if (!res.ok) return null;
  const body = (await res.json()) as { data?: Array<{ id?: string; pricing?: { prompt?: string; completion?: string } }> };
  const row = (body.data ?? []).find((item) => item.id === model);
  if (!row?.pricing) return null;
  price = { prompt: Number(row.pricing.prompt), completion: Number(row.pricing.completion) };
  return price;
}

function estimateUsd(promptText: string): number {
  if (dryRun) return Math.max(0.05, dryCallUsd);
  if (!price || !Number.isFinite(price.prompt) || !Number.isFinite(price.completion)) return 0.25;
  const promptTokens = Math.ceil(promptText.length / 4) + 300;
  return (promptTokens / 1e6) * price.prompt + (2000 / 1e6) * price.completion;
}

async function complete(messages: Array<{ role: string; content: string }>) {
  if (dryRun) return { text: "", usage: { prompt_tokens: 120, completion_tokens: 80, cost: dryCallUsd } };
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model, messages, usage: { include: true } }),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(scrub(`openrouter ${res.status}: ${raw.slice(0, 300)}`));
  const body = JSON.parse(raw) as { choices?: Array<{ message?: { content?: string } }>; usage?: { cost?: number; prompt_tokens?: number; completion_tokens?: number } };
  const text = body.choices?.[0]?.message?.content ?? "";
  const usage = body.usage ?? {};
  let cost = usage.cost;
  if (typeof cost !== "number") {
    await loadPrice();
    cost = price ? ((usage.prompt_tokens ?? 0) / 1e6) * price.prompt + ((usage.completion_tokens ?? 0) / 1e6) * price.completion : null;
  }
  return { text: typeof text === "string" ? text : JSON.stringify(text), usage: { prompt_tokens: usage.prompt_tokens ?? null, completion_tokens: usage.completion_tokens ?? null, cost } };
}

const results: unknown[] = [];
let spent = 0;
let stopped: unknown = null;
await loadPrice().catch(() => undefined);

for (const task of tasks) {
  const estimate = estimateUsd(systemPrompt + task.task);
  if (spent + estimate > maxUsd) {
    stopped = { before: task.id, spent, estimate, maxUsd };
    break;
  }
  const first = await complete([
    { role: "system", content: systemPrompt },
    { role: "user", content: task.task },
  ]);
  if (dryRun) first.text = task.broken ? brokenBar : task.canned;
  spent += Number(first.usage.cost ?? 0);
  let program = extractProgram(first.text);
  const before = check(program);
  let repair: { usage: { cost?: number | null }; validation: ReturnType<typeof check> } | null = null;
  if (!before.ok) {
    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: task.task },
      { role: "assistant", content: program },
      { role: "user", content: before.errors.map((issue) => `${issue.code} ${issue.path}: ${issue.message}`).join("\n") },
    ];
    const repairEstimate = estimateUsd(JSON.stringify(messages));
    if (spent + repairEstimate > maxUsd) {
      stopped = { before: `${task.id}:repair`, spent, estimate: repairEstimate, maxUsd };
      results.push({ task: task.id, rawProgram: program, validationBefore: before, validationAfter: null, stopped: true });
      break;
    }
    const second = await complete(messages);
    if (dryRun) second.text = task.canned;
    spent += Number(second.usage.cost ?? 0);
    program = extractProgram(second.text);
    repair = { usage: second.usage, validation: check(program) };
  }
  results.push({
    task: task.id,
    rawProgram: program,
    validationBefore: before,
    validationAfter: repair ? repair.validation : before,
  });
  if (spent >= maxUsd) {
    stopped = { after: task.id, spent, maxUsd };
    break;
  }
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
await mkdir(outDir, { recursive: true });
const outPath = path.join(outDir, `generation-${stamp}.json`);
await writeFile(
  outPath,
  JSON.stringify(
    {
      model,
      dryRun,
      maxUsd,
      spent,
      stopped,
      library: { name: LIBRARY_NAME, version: LIBRARY_VERSION },
      promptTokens: Math.ceil((vocabularyPrompt().length + systemPrompt.length) / 4),
      tasks: results,
    },
    null,
    2,
  ),
);
const summary = {
  outPath,
  dryRun,
  spent,
  stopped,
  tasks: (results as Array<{ task: string; validationBefore: { ok: boolean }; validationAfter: { ok: boolean } | null }>).map((row) => ({
    task: row.task,
    before: row.validationBefore.ok,
    after: row.validationAfter?.ok ?? null,
  })),
};
console.log(JSON.stringify(summary, null, 2));
if (dryRun && maxUsd >= 1 && results.length !== 5) process.exit(1);
if (dryRun && maxUsd >= 1 && summary.tasks.some((row) => row.after !== true)) process.exit(1);
