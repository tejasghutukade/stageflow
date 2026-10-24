import { buildScenario, fill, isoTime, rng, Transcript, type Rng } from "./builder.js";
import type { Scenario } from "../types.js";

const SERVICES = ["api-gateway", "payments-api", "ledger-db", "order-queue", "notification-worker", "auth-service"];
const ROUTES = ["/v2/cart", "/v2/pay", "/v2/orders", "/v2/session", "/v2/quote", "/healthz"];

function logMaker(r: Rng, service: string, start: number): (index: number) => string {
  let clock = start;
  return () => {
    clock += r.int(1, 40) * 1000;
    const level = r.pick(["INFO", "INFO", "INFO", "INFO", "DEBUG", "WARN"]);
    const status = level === "WARN" ? r.pick([429, 499, 503]) : r.pick([200, 200, 200, 201, 204]);
    return `${isoTime(clock)} ${level} ${service}[${r.int(100, 999)}] req=${r.hex(8)} route=${r.pick(ROUTES)} status=${status} latency_ms=${r.int(3, 480)} bytes=${r.int(200, 9000)}`;
  };
}

export function buildLogAnalysis(seed = 1): Scenario {
  const r = rng(seed);
  const t = new Transcript(r);
  t.user(
    "Produce a blameless postmortem for the checkout outage on 2026-03-14 (02:00-08:00 UTC). Read every log shard under logs/ one at a time. Find the incident id, the change that started it, the first failing dependency, the customer impact and the recovery. List unrelated warnings as ruled_out.",
  );
  t.call("bash", { command: "ls logs/*" }, SERVICES.map((s) => `logs/${s}: ${s}-01.log ${s}-02.log`).join("\n"));
  const injections: Record<number, Array<readonly [number, string]>> = {
    0: [[0.55, "2026-03-14T02:11:58Z ERROR checkout-orchestrator incident=INC-4471 opened sev=1 first_alert=02:11:58Z"]],
    2: [[0.6, "2026-03-14T02:07:31Z INFO deploy-controller build=8f3c2a91 applied flag payments.retry_v2=on actor=release-bot"]],
    4: [[0.7, "2026-03-14T02:14:05Z INFO payments-api retry_policy max_attempts=9 backoff=none jitter=0 (applied to all callers)"]],
    5: [[0.5, "2026-03-14T02:19:12Z ERROR ledger-db connection pool exhausted max=40 waiting=1187 first dependency failure"]],
    6: [[0.65, "2026-03-14T03:02:44Z WARN auth-service cert-rotation notice for jwks-2026Q1 unrelated to checkout"]],
    8: [[0.6, "2026-03-14T04:21:09Z INFO deploy-controller rollback to build=71b0de44 flag payments.retry_v2=off recovery_started"]],
    9: [[0.5, "2026-03-14T07:48:00Z INFO checkout-orchestrator incident=INC-4471 summary failed_checkouts=48211 duration_min=137"]],
  };
  for (let i = 0; i < 14; i++) {
    const service = SERVICES[i % SERVICES.length]!;
    const path = `logs/${service}/${service}-${String((i % 4) + 1).padStart(2, "0")}.log`;
    const body = fill(12000, logMaker(r, service, Date.UTC(2026, 2, 14, 2 + Math.floor(i / 3), 0, 0)), injections[i] ?? []);
    t.call("read", { path }, body, i % 4 === 0 ? { say: `Next shard: ${path}.` } : {});
  }
  return buildScenario({
    id: "log-analysis-1",
    family: "log-analysis",
    description: "14 large log shards read one at a time; incident facts sit deep inside shards, past Pi's 2000 char tool-result cut.",
    transcript: t,
    keepTail: 6,
    facts: [
      { id: "incident-id", mustContain: "INC-4471", where: "early", critical: true },
      { id: "bad-build", mustContain: "8f3c2a91", where: "early", critical: true },
      { id: "retry-policy", mustContain: /max_attempts=9\s+backoff=none\s+jitter=0/, where: "mid", critical: true },
      { id: "first-dependency", mustContain: /ledger-db[^\n]*pool[^\n]*max=40|max=40/, where: "mid", critical: false },
      { id: "ruled-out-cert", mustContain: "jwks-2026Q1", where: "mid", critical: false },
      { id: "rollback-build", mustContain: "71b0de44", where: "late", critical: true },
      { id: "impact", mustContain: "48211", where: "late", critical: true },
    ],
    probes: [
      { question: "What is the incident id?", expected: /INC-4471/, factIds: ["incident-id"] },
      { question: "Which build and flag change started the outage?", expected: /8f3c2a91/, factIds: ["bad-build"] },
      { question: "Quote the retry policy copied from the log.", expected: /max_attempts=9[\s\S]*backoff=none[\s\S]*jitter=0/, factIds: ["retry-policy"] },
      { question: "Which build did the team roll back to?", expected: /71b0de44/, factIds: ["rollback-build"] },
      { question: "How many checkouts failed?", expected: /48[, ]?211/, factIds: ["impact"] },
    ],
  });
}
