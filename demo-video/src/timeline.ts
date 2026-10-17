import dur from "./clipDurations.json";
import type { ClipConfig } from "./ClipScene";
import { outDuration } from "./ClipScene";
import { FPS } from "./theme";

const D = dur as Record<string, number>;

export const CLIPS: ClipConfig[] = [
  {
    clip: "editor",
    segs: [{ from: 0, to: D.editor, speed: 1.6 }],
    caps: [
      { at: 0.5, until: 6, title: "Workflows are plain YAML", sub: "Pipelines, stages and tasks live in your repo." },
      { at: 6.5, until: 12.5, title: "See the pipeline as a live graph", sub: "Fan-out, joins and gates, validated as you type." },
      { at: 13, until: D.editor - 0.3, title: "Every stage declares its contract", sub: "Prompt, typed I/O schema, verification and gate kind." },
    ],
    focus: [
      { t: 12.8, x: 0.5, y: 0.5, s: 1 },
      { t: 14.2, x: 0.8, y: 0.4, s: 1.5 },
      { t: D.editor, x: 0.8, y: 0.4, s: 1.5 },
    ],
  },
  {
    clip: "liverun",
    segs: [
      { from: 0, to: 9, speed: 1.0 },
      { from: 9, to: 23, speed: 2.0 },
      { from: 23, to: 38, speed: 1.1 },
      { from: 38, to: D.liverun, speed: 1.6 },
    ],
    caps: [
      { at: 1, until: 8.5, title: "Start a run", sub: "Pick a task and a pipeline. Validated before it starts." },
      { at: 10, until: 22, title: "Each stage runs in a fresh agent session", sub: "Parallel branches fan out and join on their own." },
      { at: 24, until: 30, title: "A human gate pauses the run", sub: "The editor reviews the artifacts before anything ships." },
      { at: 31, until: 38, title: "Approve with one key. The run resumes." },
      { at: 39, until: D.liverun - 0.3, title: "Published. Cost and duration tracked per run." },
    ],
    focus: [
      { t: 24, x: 0.5, y: 0.5, s: 1 },
      { t: 25.5, x: 0.7, y: 0.42, s: 1.5 },
      { t: 37, x: 0.7, y: 0.42, s: 1.5 },
      { t: 38.6, x: 0.5, y: 0.5, s: 1 },
    ],
  },
  {
    clip: "inspect",
    segs: [{ from: 0, to: D.inspect, speed: 1.9 }],
    caps: [
      { at: 0.5, until: 6.5, title: "Every run is fully inspectable", sub: "Timeline, graph and list views." },
      { at: 7, until: 13.5, title: "Per-stage transcripts, tokens and cost", pos: "top" },
      { at: 14, until: 18.5, title: "Events and typed envelopes", sub: "The exact handoff each stage emitted.", pos: "top" },
      { at: 19, until: D.inspect - 0.3, title: "Artifacts open in place", sub: "Evidence a reviewer, and the next stage, can rely on.", pos: "top" },
    ],
    focus: [
      { t: 10.5, x: 0.5, y: 0.5, s: 1 },
      { t: 12, x: 0.5, y: 0.8, s: 1.25 },
      { t: D.inspect, x: 0.5, y: 0.8, s: 1.25 },
    ],
  },
  {
    clip: "agents",
    segs: [{ from: 0, to: D.agents, speed: 1.5 }],
    caps: [
      { at: 0.5, until: 5, title: "Agents: project-owned, revisioned YAML", sub: "Granted tools, ask-first approvals, reachable on channels." },
      { at: 6, until: 11.5, title: "Every session is traced", sub: "Messages, tool calls, tokens and cost." },
      { at: 12.5, until: D.agents - 0.3, title: "Least privilege by configuration", sub: "Each agent sees only the tools you grant it." },
    ],
  },
  {
    clip: "approval",
    segs: [{ from: 0, to: D.approval, speed: 1.1 }],
    caps: [
      { at: 0.5, until: 5, title: "Risky actions ask first", sub: "File edits and shell commands pause until an operator decides." },
      { at: 6, until: D.approval - 0.2, title: "Approve, and the agent continues" },
    ],
    focus: [
      { t: 0.8, x: 0.5, y: 0.5, s: 1 },
      { t: 2, x: 0.7, y: 0.36, s: 1.45 },
      { t: 5.2, x: 0.7, y: 0.36, s: 1.45 },
      { t: 6.2, x: 0.5, y: 0.5, s: 1 },
    ],
  },
  {
    clip: "webchat",
    segs: [{ from: 0, to: D.webchat, speed: 2.2 }],
    caps: [
      { at: 0.5, until: 6, title: "Publish an agent as a public chat page", sub: "One link. No code.", pos: "top" },
      { at: 7, until: D.webchat - 0.3, title: "Or reach it on Slack, Telegram, iMessage and email", pos: "top" },
    ],
  },
  {
    clip: "connect",
    segs: [{ from: 0, to: D.connect, speed: 2.2 }],
    caps: [
      { at: 0.5, until: 5, title: "Connections", sub: "Channels and tool servers, configured once.", pos: "top" },
      { at: 5.5, until: D.connect - 0.3, title: "Secrets stay on the host", sub: "Never written to YAML, logs or run state.", pos: "top" },
    ],
  },
];

const s = (sec: number) => Math.round(sec * FPS);
export const INTRO = s(6);
export const PROBLEM = s(7.5);
export const SOLUTION = s(7.5);
export const ANYWHERE = s(12);
export const OUTRO = s(7);
export const clipFrames = (c: ClipConfig) => Math.round(outDuration(c.segs) * FPS);
export const TOTAL = INTRO + PROBLEM + SOLUTION + CLIPS.reduce((a, c) => a + clipFrames(c), 0) + ANYWHERE + OUTRO;
