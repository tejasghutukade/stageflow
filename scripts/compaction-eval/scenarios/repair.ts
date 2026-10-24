import { buildScenario, fill, isoTime, rng, Transcript, type Rng } from "./builder.js";
import type { Scenario } from "../types.js";

function csvRows(r: Rng): (index: number) => string {
  let clock = Date.UTC(2026, 2, 14, 2, 0, 0);
  return () => {
    clock += r.int(1, 90) * 1000;
    return `${isoTime(clock)},${r.pick(["checkout", "cart", "pay"])},${r.int(0, 50)},${r.hex(8)},${r.pick(["ok", "ok", "ok", "retry"])}`;
  };
}

export function buildRepair(seed = 5): Scenario {
  const r = rng(seed);
  const t = new Transcript(r);
  t.user(
    "Attempt 2 of 3. The previous attempt failed verification. Evidence from attempt 1: check `schema` failed: field impact.duration_min must be an integer, got the string '137 min'; check `evidence-files` failed: artifact timeline.md missing. Fix both and emit the envelope.",
  );
  t.say("Plan: rebuild the timeline from the exports, then re-emit with an integer duration_min.");
  t.call("bash", { command: "cat data/summary.csv" }, "cat: data/summary.csv: No such file or directory", { isError: true });
  t.say("Dead end: data/summary.csv does not exist (ENOENT). Do not retry reading summary.csv; use data/events-*.csv instead.");
  t.call("bash", { command: "ls data" }, "events-01.csv\nevents-02.csv\nevents-03.csv\nevents-04.csv\nevents-05.csv\nevents-06.csv\nevents-07.csv\nevents-08.csv");
  const inject: Record<number, Array<readonly [number, string]>> = {
    0: [[0.6, "2026-03-14T02:11:58Z,checkout,0,c0ffee11,ok first failure window opens (INC-4471)"]],
    2: [[0.5, "2026-03-14T04:21:09Z,pay,0,deadbeef,ok recovery marker rollback complete build 71b0de44"]],
    5: [[0.5, "2026-03-14T07:48:00Z,checkout,0,facefeed,ok closing line duration_min=137 failed_checkouts=48211"]],
  };
  for (let i = 0; i < 8; i++) {
    t.call("read", { path: `data/events-0${i + 1}.csv` }, fill(19000, csvRows(r), inject[i] ?? []));
    if (i === 3) t.call("write_stage_artifact", { path: "timeline.md", content: "# timeline (draft)" }, "wrote timeline.md (draft)");
  }
  t.call("emit_stage_envelope", { impact: { duration_min: 137, failed_checkouts: 48211 } }, "Rejected: pre_emit check evidence-files failed again: timeline.md must list at least 8 entries (found 3).", { isError: true });
  t.say("Next step: extend timeline.md to 8+ entries from the events, then re-emit with duration_min as the integer 137.");
  t.call("read", { path: "timeline.md" }, "# timeline (draft)\n- 02:11:58Z first failure\n- 04:21:09Z rollback\n- 07:48:00Z closed");
  t.call("read", { path: "data/events-01.csv" }, fill(5000, csvRows(r)));
  t.call("bash", { command: "wc -l data/*.csv" }, "  9010 total");
  return buildScenario({
    id: "repair-1",
    family: "repair",
    description: "Attempt 2: verification failure evidence in the first message, a dead end that must not be retried, an in-flight next step.",
    transcript: t,
    keepTail: 6,
    facts: [
      { id: "failure-schema", mustContain: "impact.duration_min must be an integer", where: "early", critical: true },
      { id: "failure-evidence", mustContain: "timeline.md missing", where: "early", critical: true },
      { id: "dead-end", mustContain: "Do not retry reading summary.csv", where: "early", critical: true },
      { id: "first-failure-ts", mustContain: "2026-03-14T02:11:58Z", where: "early", critical: false },
      { id: "rollback-ts", mustContain: "2026-03-14T04:21:09Z", where: "mid", critical: true },
      { id: "rejected-emit", mustContain: "found 3", where: "late", critical: true },
      { id: "next-step", mustContain: "extend timeline.md to 8+ entries", where: "late", critical: true },
    ],
    probes: [
      { question: "What type must impact.duration_min be, and what did the previous attempt emit wrong?", expected: /integer/i, factIds: ["failure-schema"] },
      { question: "Which file read is a dead end that must not be retried?", expected: /summary\.csv/, factIds: ["dead-end"] },
      { question: "What is the planned next step?", expected: /timeline\.md/, factIds: ["next-step"] },
      { question: "Why did the last emit get rejected?", expected: /8|found 3|entries/, factIds: ["rejected-emit"] },
    ],
  });
}
