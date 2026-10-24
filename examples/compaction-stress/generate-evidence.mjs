#!/usr/bin/env node
// Writes a deterministic ~700 KB incident log set plus expected.json (ground truth, written next to the dir so the stage cannot read it).
// Usage: node generate-evidence.mjs <outDir>
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const outDir = path.resolve(process.argv[2] ?? "./evidence");
const DATE = "2026-03-14";
const SERVICES = ["api-gateway", "payments-api", "ledger-db", "order-queue", "notification-worker", "auth-service"];
const SHARDS_PER_SERVICE = 2;
const LINES_PER_SHARD = 400;
const START = Date.parse(`${DATE}T02:00:00Z`);
const END = Date.parse(`${DATE}T08:00:00Z`);

let seed = 20260314;
const rnd = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 2 ** 32;
};
const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
const hex = (n) => Array.from({ length: n }, () => "0123456789abcdef"[Math.floor(rnd() * 16)]).join("");
const iso = (ms) => new Date(ms).toISOString().replace(".000Z", "Z");

const noise = {
  "api-gateway": () => `INFO route=${pick(["/v2/checkout", "/v2/cart", "/v2/orders", "/v2/profile"])} status=200 latency_ms=${20 + Math.floor(rnd() * 90)} req=${hex(12)} client=${pick(["web", "ios", "android"])}`,
  "payments-api": () => `INFO charge_authorized order=${hex(8)} amount_cents=${500 + Math.floor(rnd() * 20000)} psp=${pick(["stripe", "adyen"])} attempt=1 dur_ms=${80 + Math.floor(rnd() * 200)}`,
  "ledger-db": () => `INFO txn_commit id=${hex(10)} rows=${1 + Math.floor(rnd() * 4)} pool_active=${20 + Math.floor(rnd() * 40)}/200 dur_ms=${2 + Math.floor(rnd() * 15)}`,
  "order-queue": () => `INFO msg_ack topic=${pick(["order.created", "order.paid", "order.shipped"])} depth=${Math.floor(rnd() * 40)} consumer=c-${Math.floor(rnd() * 8)}`,
  "notification-worker": () => `INFO sent channel=${pick(["email", "push", "sms"])} template=${pick(["receipt", "shipping", "promo"])} user=u${Math.floor(rnd() * 90000)}`,
  "auth-service": () => `INFO token_issued user=u${Math.floor(rnd() * 90000)} ttl_s=3600 mfa=${pick(["totp", "none", "webauthn"])}`,
};

// Needles: [service, UTC time of day, line]. The shard and position follow the time.
const needles = [
  ["payments-api", "02:08:07", "INFO deploy build=7f3a91c author=dkaplan flag payments.retry_v2=on rollout=100% retry_policy max_attempts=7 backoff=none jitter=none"],
  ["payments-api", "02:19:30", "WARN psp_timeout psp=stripe order=ab12cd34 attempt=2 retrying immediately"],
  ["ledger-db", "02:31:44", "ERROR connection pool exhausted active=200/200 waiting=1873 first_seen=02:31:44Z"],
  ["order-queue", "03:02:10", "ERROR dlq_growth topic=order.paid dlq_depth=5000 oldest_msg_age_s=612"],
  ["api-gateway", "03:10:12", "ERROR slo_breach route=/v2/checkout error_rate=38% window=5m paged_oncall=maria.chen incident_declared=INC-4471"],
  ["notification-worker", "03:55:00", "WARN backlog receipts_pending=22914 throttled_by=order-queue"],
  ["auth-service", "04:15:00", "WARN cert_expiry host=auth-internal.example.net expires_in_days=9 (unrelated to incident)"],
  ["payments-api", "05:47:30", "INFO rollback build=7f3a91c -> 6e21b0d flag payments.retry_v2=off by=maria.chen"],
  ["ledger-db", "05:49:10", "INFO connection pool recovered active=64/200 waiting=0"],
  ["api-gateway", "05:52:03", "INFO recovery route=/v2/checkout error_rate=0.4% window=5m resolved_at=05:52:03Z"],
  ["api-gateway", "07:40:00", "INFO incident_summary id=INC-4471 failed_checkouts=48211 duration_min=201 sev=1"],
];
const needleMs = (hhmmss) => Date.parse(`${DATE}T${hhmmss}Z`);

for (const service of SERVICES) {
  mkdirSync(path.join(outDir, "logs", service), { recursive: true });
  for (let shard = 1; shard <= SHARDS_PER_SERVICE; shard += 1) {
    const span = (END - START) / SHARDS_PER_SERVICE;
    const t0 = START + (shard - 1) * span;
    const lines = [];
    for (let i = 0; i < LINES_PER_SHARD; i += 1) {
      const ts = t0 + (i / LINES_PER_SHARD) * span;
      lines.push(`${iso(Math.floor(ts / 1000) * 1000)} ${service} ${noise[service]()}`);
    }
    for (const [svc, time, text] of needles) {
      const ms = needleMs(time);
      if (svc !== service || Math.floor((ms - START) / span) + 1 !== shard) continue;
      const at = Math.floor(((ms - t0) / span) * LINES_PER_SHARD);
      lines.splice(at, 0, `${iso(ms)} ${service} ${text}`);
    }
    writeFileSync(path.join(outDir, "logs", service, `${service}-${String(shard).padStart(2, "0")}.log`), `${lines.join("\n")}\n`);
  }
}

mkdirSync(path.join(outDir, "runbooks"), { recursive: true });
writeFileSync(
  path.join(outDir, "runbooks", "payments-retry-policy.md"),
  `# Payments retry policy (owner: payments-platform)

- Client retries to a PSP must use exponential backoff with full jitter.
- max_attempts must not exceed 3 without a circuit breaker.
- Feature flags that change retry behavior require a canary at 5% for 30 minutes before 100% rollout.
- A change that raises ledger-db connection demand needs a pool capacity review.
`,
);
writeFileSync(
  path.join(outDir, "runbooks", "severity-and-comms.md"),
  `# Severity and comms

- Sev 1: customer-facing checkout failure above 20% for 5 minutes. Page oncall, open an incident channel, post status page update within 15 minutes.
- Postmortems are due within 5 business days. Action items need an owner and a due date.
`,
);

writeFileSync(
  `${outDir}.expected.json`,
  JSON.stringify(
    {
      incident_id: "INC-4471",
      root_cause_build: "7f3a91c",
      root_cause_flag: "payments.retry_v2",
      retry_policy: { max_attempts: 7, backoff: "none", jitter: "none" },
      first_pool_exhaustion_utc: "02:31:44Z",
      dlq_depth: 5000,
      paged_oncall: "maria.chen",
      rollback_to_build: "6e21b0d",
      recovery_utc: "05:52:03Z",
      failed_checkouts: 48211,
      duration_min: 201,
      red_herring: "auth-internal.example.net cert expiry",
    },
    null,
    2,
  ),
);
console.log(`wrote evidence to ${outDir}`);
