import { buildScenario, rng, Transcript, type Rng } from "./builder.js";
import type { Scenario } from "../types.js";

const DOMAINS = ["blog.example.org", "news.example.net", "docs.example.dev", "forum.example.io", "wiki.example.com"];

function results(r: Rng, count: number, inject: Record<number, Record<string, unknown>> = {}): string {
  const rows = [];
  for (let i = 0; i < count; i++) {
    rows.push(
      inject[i] ?? {
        title: `Notes on ${r.pick(["pricing", "limits", "latency", "migration", "support", "security"])} ${r.hex(4)}`,
        url: `https://${r.pick(DOMAINS)}/p/${r.hex(10)}`,
        snippet: Array.from({ length: 14 }, () => r.pick(["vendor", "tier", "usage", "limit", "plan", "annual", "quota", "region", "enterprise", "invoice"])).join(" "),
        score: Number(r.next().toFixed(3)),
      },
    );
  }
  return JSON.stringify({ results: rows }, null, 2);
}

function page(r: Rng, chars: number, inject: string[] = []): string {
  const parts: string[] = [];
  let length = 0;
  while (length < chars) {
    const p = Array.from({ length: 40 }, () => r.pick(["The", "service", "offers", "several", "plans", "for", "teams", "with", "varied", "needs", "and", "support", "options", "across", "regions"])).join(" ");
    parts.push(p);
    length += p.length + 2;
  }
  inject.forEach((line, i) => parts.splice(Math.floor(((i + 1) * parts.length) / (inject.length + 1)), 0, line));
  return parts.join("\n\n");
}

export function buildResearch(seed = 3): Scenario {
  const r = rng(seed);
  const t = new Transcript(r);
  t.user("Research payment vendors for our EU launch. Compare rate limits, per-1k pricing and security posture. Cite sources with URLs. End with a shortlist.");
  t.call("web_search", { query: "Acmepay API rate limits v3" }, results(r, 40, { 3: { title: "Acmepay API v3 limits", url: "https://docs.acmepay.example/v3/limits", snippet: "Default rate limit is 1200 req/min per key", score: 0.97 } }));
  t.call("web_fetch", { url: "https://docs.acmepay.example/v3/limits" }, page(r, 16000, ["Rate limits: the default is 1200 req/min per API key; burst 2x for 10s. Contact sales for higher."]));
  t.call("web_search", { query: "Borealis payments pricing per 1k transactions" }, results(r, 40, { 5: { title: "Borealis pricing", url: "https://borealis.example/pricing", snippet: "$0.0042 per 1k transactions on the Scale tier", score: 0.93 } }));
  t.call("web_fetch", { url: "https://borealis.example/pricing" }, page(r, 16000, ["Scale tier: $0.0042 per 1k transactions, volume above 50M billed monthly."]));
  t.call("web_search", { query: "Borealis changelog 2025" }, results(r, 30));
  t.call("web_fetch", { url: "https://blog.example.org/borealis-changelog" }, page(r, 12000));
  t.call("mcp__scholar__search", { q: "payment API availability SLAs study" }, results(r, 40, { 7: { title: "Availability of payment APIs", url: "https://arxiv.org/abs/2503.11942", snippet: "Smith et al. 2025, arXiv:2503.11942 reports 99.95% median availability", score: 0.9 } }));
  t.call("web_fetch", { url: "https://arxiv.org/abs/2503.11942" }, page(r, 15000, ["Smith et al. 2025 (arXiv:2503.11942) measure median availability of 99.95% across 14 providers."]));
  t.call("web_search", { query: "Cobalt pay security incident 2025" }, results(r, 40));
  t.call("web_fetch", { url: "https://news.example.net/cobalt-incident" }, page(r, 15000, ["Cobalt disclosed a breach on 2025-11-02 affecting merchant API keys; the vendor was removed from consideration."]));
  t.call("web_search", { query: "Acmepay vs Borealis uptime" }, results(r, 40, { 4: { title: "Uptime comparison", url: "https://status.example.dev/compare", snippet: "Conflicting claim: Acmepay lists 1000 req/min on its pricing page", score: 0.55 } }));
  t.say("One source says 1000 req/min on a pricing page; the docs page says 1200 req/min. The docs page is authoritative.");
  t.call("web_fetch", { url: "https://status.example.dev/compare" }, page(r, 15000));
  t.call("mcp__scholar__search", { q: "EU PSD3 compliance payment vendors" }, results(r, 40));
  t.call("web_fetch", { url: "https://wiki.example.com/psd3" }, page(r, 15000, ["Decision criterion agreed: shortlist vendors with >=99.9% availability and no 2025 breach."]));
  t.call("web_search", { query: "payment vendor support SLA enterprise" }, results(r, 40));
  t.call("web_fetch", { url: "https://blog.example.org/p/support" }, page(r, 15000));
  t.call("web_search", { query: "final check vendor regions EU" }, results(r, 40));
  t.call("web_fetch", { url: "https://docs.example.dev/regions" }, page(r, 15000));
  t.call("web_search", { query: "currency settlement times" }, results(r, 20));
  t.call("web_fetch", { url: "https://forum.example.io/settlement" }, page(r, 8000));
  return buildScenario({
    id: "research-1",
    family: "research",
    description: "Web search and fetch results as large JSON and pages; URLs, numbers and citations spread across the run.",
    transcript: t,
    keepTail: 6,
    facts: [
      { id: "acme-limit", mustContain: "1200 req/min", where: "early", critical: true },
      { id: "acme-url", mustContain: "https://docs.acmepay.example/v3/limits", where: "early", critical: true },
      { id: "borealis-price", mustContain: "$0.0042 per 1k", where: "early", critical: true },
      { id: "citation", mustContain: "arXiv:2503.11942", where: "mid", critical: true },
      { id: "availability", mustContain: "99.95%", where: "mid", critical: false },
      { id: "cobalt-excluded", mustContain: "2025-11-02", where: "mid", critical: true },
      { id: "criterion", mustContain: "no 2025 breach", where: "late", critical: false },
    ],
    probes: [
      { question: "What is Acmepay's default rate limit and which URL documents it?", expected: /1200/, factIds: ["acme-limit", "acme-url"] },
      { question: "What does Borealis charge per 1k transactions on the Scale tier?", expected: /0\.0042/, factIds: ["borealis-price"] },
      { question: "Which paper reports provider availability? Give the arXiv id.", expected: /2503\.11942/, factIds: ["citation"] },
      { question: "Why was Cobalt removed and when was the breach disclosed?", expected: /2025-11-02|breach/i, factIds: ["cobalt-excluded"] },
    ],
  });
}
