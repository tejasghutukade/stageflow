import { buildScenario, fill, isoTime, rng, Transcript, type Rng } from "./builder.js";
import type { Scenario } from "../types.js";

function rows(r: Rng, table: string): (index: number) => string {
  let clock = Date.UTC(2026, 2, 20, 9, 0, 0);
  return () => {
    clock += r.int(1, 300) * 1000;
    return `${r.int(10000, 99999)} | ${table} | ${isoTime(clock)} | ${r.pick(["active", "paused", "pending", "closed"])} | owner=u${r.int(100, 999)} | region=${r.pick(["eu", "us", "ap"])}`;
  };
}

function ask(t: Transcript, question: string, answer: string): void {
  t.call("ask_operator", { question, options: ["yes", "no", "other"] }, `Operator answered: ${answer}`);
}

export function buildOperatorQa(seed = 4): Scenario {
  const r = rng(seed);
  const t = new Transcript(r);
  t.user("Migrate the customer tables to the new schema. Ask the operator whenever a decision is not in the task. Do not guess.");
  ask(t, "Which database should I run the migration against?", "Use the staging database stg-db-03. Never touch production prod-db-01.");
  t.call("bash", { command: "psql stg-db-03 -c 'select * from customers limit 4000'" }, fill(15000, rows(r, "customers")));
  ask(t, "What is the spend cap for the temporary replica?", "Budget cap is 250 USD for the whole migration; stop and ask if you expect to exceed it.");
  t.call("bash", { command: "psql stg-db-03 -c 'select * from orders limit 4000'" }, fill(15000, rows(r, "orders")));
  t.call("bash", { command: "psql stg-db-03 -c 'select * from invoices limit 4000'" }, fill(15000, rows(r, "invoices")));
  ask(t, "By when must the migration finish?", "Deadline is 2026-04-02 17:00 UTC. Do not start the cutover before the 2026-03-30 freeze ends.");
  t.call("bash", { command: "psql stg-db-03 -c 'select * from sessions limit 4000'" }, fill(15000, rows(r, "sessions")));
  t.call("bash", { command: "psql stg-db-03 -c 'select * from audit limit 4000'" }, fill(15000, rows(r, "audit")));
  ask(t, "Design A keeps both columns for 30 days, design B drops the legacy column immediately. Which one?", "Approved design B: drop legacy_email immediately, but keep a backup table named customers_bak_20260320.");
  t.call("bash", { command: "psql stg-db-03 -c 'select * from tokens limit 4000'" }, fill(15000, rows(r, "tokens")));
  t.call("bash", { command: "psql stg-db-03 -c 'select * from devices limit 4000'" }, fill(15000, rows(r, "devices")));
  t.call("emit_stage_envelope", { status: "ok", plan: "drop legacy_email" }, "Rejected by operator: plan must name the backup table customers_bak_20260320 explicitly. Re-emit with that field.", { isError: true });
  t.call("bash", { command: "psql stg-db-03 -c 'select * from regions limit 4000'" }, fill(15000, rows(r, "regions")));
  t.call("bash", { command: "psql stg-db-03 -c 'select * from plans limit 4000'" }, fill(15000, rows(r, "plans")));
  t.call("bash", { command: "psql stg-db-03 -c 'select * from notes limit 4000'" }, fill(15000, rows(r, "notes")));
  t.call("bash", { command: "psql stg-db-03 -c 'select * from tags limit 4000'" }, fill(15000, rows(r, "tags")));
  t.call("bash", { command: "psql stg-db-03 -c 'select * from flags limit 4000'" }, fill(12000, rows(r, "flags")));
  return buildScenario({
    id: "operator-qa-1",
    family: "operator-qa",
    description: "ask_operator turns early in the run; the operator's answers and a rejected emit must survive later noise.",
    transcript: t,
    keepTail: 6,
    facts: [
      { id: "db-choice", mustContain: "stg-db-03", where: "early", critical: true },
      { id: "db-forbidden", mustContain: "Never touch production prod-db-01", where: "early", critical: true },
      { id: "budget", mustContain: "250 USD", where: "early", critical: true },
      { id: "deadline", mustContain: "2026-04-02 17:00 UTC", where: "mid", critical: true },
      { id: "freeze", mustContain: "2026-03-30 freeze", where: "mid", critical: false },
      { id: "design-b", mustContain: "Approved design B", where: "mid", critical: true },
      { id: "backup-table", mustContain: "customers_bak_20260320", where: "mid", critical: true },
      { id: "rejected-emit", mustContain: "plan must name the backup table", where: "late", critical: true },
    ],
    probes: [
      { question: "Which database may the migration run against, and which is forbidden?", expected: /stg-db-03/, factIds: ["db-choice", "db-forbidden"] },
      { question: "What is the budget cap the operator set?", expected: /250/, factIds: ["budget"] },
      { question: "What is the deadline?", expected: /2026-04-02/, factIds: ["deadline"] },
      { question: "Which design did the operator approve and what backup table must exist?", expected: /customers_bak_20260320/, factIds: ["design-b", "backup-table"] },
      { question: "Why was the last emit rejected?", expected: /backup table/i, factIds: ["rejected-emit"] },
    ],
  });
}
