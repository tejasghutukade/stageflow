import { buildScenario, paragraph, rng, Transcript } from "./builder.js";
import type { Scenario } from "../types.js";

export function buildProjectAgent(seed = 7): Scenario {
  const r = rng(seed);
  const t = new Transcript(r);
  t.user("Hi, I'm Dana. I'm leading Project Halcyon. A few ground rules for how you work with me: I prefer metric units, and my timezone is Asia/Kolkata.");
  t.say("Nice to meet you, Dana. Noted: metric units and Asia/Kolkata. " + paragraph(r, 600));
  const topics = ["roadmap", "hiring", "vendor review", "risk register", "budget", "launch checklist", "customer interviews", "infra costs"];
  let turn = 0;
  const chat = (count: number): void => {
    for (let i = 0; i < count; i++) {
      const topic = topics[turn % topics.length]!;
      t.user(`Next, let's talk about the ${topic}. ${paragraph(r, 1800)}`);
      if (turn % 3 === 0) t.call("calendar_list", { week: turn }, JSON.stringify(Array.from({ length: 30 }, (_, n) => ({ id: r.hex(8), title: `Sync ${r.hex(3)}`, day: n % 7 })), null, 1));
      t.say(`On the ${topic}: ${paragraph(r, 3000)}`);
      turn++;
    }
  };
  chat(9);
  t.user("Important preference: always answer me in at most 5 bullet points, and never use emoji.");
  t.say("Understood: at most 5 bullet points, no emoji.");
  chat(8);
  t.user("Also, do not email Priya about the budget before Friday 2026-04-10. She is on leave until then.");
  t.say("Noted: no email to Priya about the budget before 2026-04-10.");
  chat(8);
  t.user("Decision from the steering call: the launch date for Halcyon is 2026-06-15, and the working codename for the pricing page is Lantern.");
  t.say("Recorded: launch 2026-06-15, pricing page codename Lantern.");
  chat(9);
  t.user("Quick check on how I like things. " + paragraph(r, 300));
  t.say("Sure. " + paragraph(r, 500));
  t.user("Thanks. One more thing for later. " + paragraph(r, 300));
  t.say(paragraph(r, 500));
  t.user("Great, carrying on. " + paragraph(r, 300));
  t.say(paragraph(r, 500));
  return buildScenario({
    id: "project-agent-1",
    family: "project-agent",
    description: "Long project-agent chat with user preferences, a constraint on emailing and a late decision.",
    transcript: t,
    keepTail: 6,
    facts: [
      { id: "name", mustContain: "Dana", where: "early", critical: false },
      { id: "units", mustContain: "metric units", where: "early", critical: true },
      { id: "timezone", mustContain: "Asia/Kolkata", where: "early", critical: true },
      { id: "format-rule", mustContain: "at most 5 bullet points", where: "early", critical: true },
      { id: "priya", mustContain: "before Friday 2026-04-10", where: "mid", critical: true },
      { id: "launch", mustContain: "2026-06-15", where: "late", critical: true },
      { id: "codename", mustContain: "Lantern", where: "late", critical: false },
    ],
    probes: [
      { question: "What unit system and timezone does the user prefer?", expected: /metric[\s\S]*Kolkata|Kolkata[\s\S]*metric/i, factIds: ["units", "timezone"] },
      { question: "How many bullet points at most should answers have?", expected: /\b5\b|five/i, factIds: ["format-rule"] },
      { question: "Who must not be emailed about the budget, and until when?", expected: /Priya/, factIds: ["priya"] },
      { question: "What is the launch date for Halcyon?", expected: /2026-06-15|June 15/, factIds: ["launch"] },
    ],
  });
}
