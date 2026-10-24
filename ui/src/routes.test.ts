import { describe, expect, it } from "vitest";
import {
  agentPath,
  agentCreatePath,
  agentRunPath,
  agentSessionPath,
  agentSessionsPath,
  agentsPath,
  catalogPath,
  datasetPath,
  datasetsPath,
  evalCasePath,
  evalComparePath,
  evalEditPath,
  evalNewPath,
  evalPath,
  evalRunPath,
  evalsPath,
  extensionFilePath,
  extensionPackagePath,
  inboxPath,
  memoriesPath,
  memoryPath,
  newRunPath,
  parseHash,
  pipelinePath,
  runStagePath,
  stagePath,
  workshopPath,
} from "./routes";

describe("parseHash", () => {
  it("parses the catalog route with default stages tab", () => {
    expect(parseHash("#/catalog")).toEqual({ name: "catalog", tab: "stages" });
  });

  it("parses catalog skills tab and skill query", () => {
    expect(parseHash(`#${catalogPath({ tab: "skills", skill: "code-review" })}`)).toEqual({
      name: "catalog",
      tab: "skills",
      skillName: "code-review",
    });
  });

  it("parses the skills list", () => {
    expect(parseHash("#/skills")).toEqual({ name: "skills" });
  });

  it("parses a skill detail name", () => {
    expect(parseHash("#/skills/brave-search")).toEqual({
      name: "skill",
      skillName: "brave-search",
    });
  });

  it("parses the extensions list", () => {
    expect(parseHash("#/extensions")).toEqual({ name: "extensions" });
  });

  it("parses an extension package detail", () => {
    const hash = `#${extensionPackagePath("user", "npm:pi-cursor-sdk")}`;
    expect(parseHash(hash)).toEqual({
      name: "extensionPackage",
      scope: "user",
      source: "npm:pi-cursor-sdk",
    });
  });

  it("parses an extension file detail with encoded path", () => {
    const filePath = "/tmp/agent/extensions/fixture-user.ts";
    expect(parseHash(`#${extensionFilePath(filePath)}`)).toEqual({
      name: "extensionFile",
      path: filePath,
    });
  });

  it("parses a stage file editor route with optional project_root", () => {
    const filePath = "pipelines/step.yaml";
    const root = "/Users/me/project-a";
    expect(parseHash(`#${stagePath(filePath)}`)).toEqual({
      name: "stage",
      path: filePath,
    });
    expect(
      parseHash(`#${stagePath(filePath, { project_root: root })}`),
    ).toEqual({
      name: "stage",
      path: filePath,
      projectRoot: root,
    });
  });

  it("parses the provider connect route", () => {
    expect(parseHash("#/connect")).toEqual({ name: "connect" });
  });

  it("parses the overview route", () => {
    expect(parseHash("#/overview")).toEqual({ name: "overview" });
  });

  it("parses memories list and detail routes", () => {
    expect(parseHash(`#${memoriesPath()}`)).toEqual({ name: "memories" });
    expect(parseHash(`#${memoryPath("candidate-pool")}`)).toEqual({
      name: "memory",
      memoryId: "candidate-pool",
    });
  });

  it("parses the inbox route", () => {
    expect(parseHash("#/inbox")).toEqual({ name: "inbox" });
  });

  it("parses inbox tab query", () => {
    expect(parseHash("#/inbox?tab=failed")).toEqual({
      name: "inbox",
      tab: "failed",
    });
    expect(parseHash("#/inbox?tab=done_today")).toEqual({
      name: "inbox",
      tab: "done_today",
    });
    expect(parseHash(`#${inboxPath("failed")}`)).toEqual({
      name: "inbox",
      tab: "failed",
    });
    expect(parseHash("#/inbox?tab=needs")).toEqual({ name: "inbox" });
  });

  it("parses pipeline detail with optional project_root query", () => {
    const root = "/Users/me/project-a";
    const hash = `#${pipelinePath("hello", { project_root: root })}`;
    expect(parseHash(hash)).toEqual({
      name: "pipeline",
      pipelineId: "hello",
      projectRoot: root,
    });
    expect(parseHash("#/pipelines/hello")).toEqual({
      name: "pipeline",
      pipelineId: "hello",
    });
  });

  it("parses the workshop route", () => {
    expect(parseHash("#/workshop")).toEqual({ name: "workshop" });
    expect(parseHash("#/workshop?session=sess-abc")).toEqual({
      name: "workshop",
      sessionId: "sess-abc",
    });
    expect(parseHash(`#${workshopPath({ session: "sess-abc" })}`)).toEqual({
      name: "workshop",
      sessionId: "sess-abc",
    });
  });

  it("redirects workshop-lab hash to workshop route", () => {
    expect(parseHash("#/workshop-lab")).toEqual({ name: "workshop" });
  });

  it("parses workshop open query params", () => {
    expect(
      parseHash("#/workshop?pipeline=pipelines%2Fdemo.pipeline.yaml"),
    ).toEqual({
      name: "workshop",
      pipelinePath: "pipelines/demo.pipeline.yaml",
    });
    expect(
      parseHash(
        "#/workshop?pipeline=pipelines/demo.pipeline.yaml&task=pipelines/demo.task.yaml",
      ),
    ).toEqual({
      name: "workshop",
      pipelinePath: "pipelines/demo.pipeline.yaml",
      taskPath: "pipelines/demo.task.yaml",
    });
    expect(
      parseHash(
        `#${workshopPath({
          pipeline: "pipelines/demo.pipeline.yaml",
          task: "pipelines/demo.task.yaml",
          project_root: "examples",
        })}`,
      ),
    ).toEqual({
      name: "workshop",
      pipelinePath: "pipelines/demo.pipeline.yaml",
      taskPath: "pipelines/demo.task.yaml",
      projectRoot: "examples",
    });
  });

  it("opens inbox for an empty hash and for #/today", () => {
    expect(parseHash("")).toEqual({ name: "inbox" });
    expect(parseHash("#/today")).toEqual({ name: "inbox" });
  });

  it("falls aui sample hash through to inbox", () => {
    expect(parseHash("#/aui")).toEqual({ name: "inbox" });
  });

  it("falls astryx sample hash through to inbox", () => {
    expect(parseHash("#/astryx")).toEqual({ name: "inbox" });
  });

  it("falls unknown hashes through to inbox", () => {
    expect(parseHash("#/not-a-real-route")).toEqual({ name: "inbox" });
  });

  it("parses New Run query params used by the Workshop Run shortcut", () => {
    const path = newRunPath({
      pipeline: "pipelines/demo.pipeline.yaml",
      task: "pipelines/demo.task.yaml",
    });
    expect(parseHash(`#${path}`)).toEqual({
      name: "new",
      pipelineId: "pipelines/demo.pipeline.yaml",
      taskPath: "pipelines/demo.task.yaml",
    });
    const rooted = newRunPath({
      pipeline: "pipelines/demo.pipeline.yaml",
      task: "pipelines/demo.task.yaml",
      project_root: "/repo/examples",
    });
    expect(parseHash(`#${rooted}`)).toEqual({
      name: "new",
      pipelineId: "pipelines/demo.pipeline.yaml",
      taskPath: "pipelines/demo.task.yaml",
      projectRoot: "/repo/examples",
    });
  });
});

describe("agent routes", () => {
  it("opens the directory", () => {
    expect(parseHash(`#${agentsPath()}`)).toEqual({ name: "agents" });
    expect(parseHash(`#${agentSessionsPath()}`)).toEqual({ name: "agentSessions" });
    expect(parseHash(`#${agentCreatePath()}`)).toEqual({ name: "agentCreate" });
    expect(parseHash(`#${agentCreatePath({ session: "draft-1" })}`)).toEqual({
      name: "agentCreate",
      authorSessionId: "draft-1",
    });
  });

  it("opens detail, edit, and a missing agent id", () => {
    expect(parseHash(`#${agentPath("research_assistant")}`)).toEqual({
      name: "agent",
      agentId: "research_assistant",
      screen: "detail",
    });
    expect(parseHash(`#${agentPath("research_assistant", "edit")}`)).toEqual({
      name: "agent",
      agentId: "research_assistant",
      screen: "edit",
    });
    expect(parseHash("#/agents/missing_agent")).toEqual({
      name: "agent",
      agentId: "missing_agent",
      screen: "detail",
    });
  });

  it("opens a session and a run inside it", () => {
    expect(parseHash(`#${agentSessionPath("research_assistant", "ses_8f2c")}`)).toEqual({
      name: "agentSession",
      agentId: "research_assistant",
      sessionId: "ses_8f2c",
    });
    expect(parseHash(`#${agentRunPath("research_assistant", "ses_8f2c", "4")}`)).toEqual({
      name: "agentRun",
      agentId: "research_assistant",
      sessionId: "ses_8f2c",
      runId: "4",
    });
  });
});

describe("run stage hash", () => {
  it("parses a stream stage path", () => {
    expect(parseHash("#/runs/r1/stages/design")).toEqual({
      name: "detail",
      runId: "r1",
      view: { kind: "stream", stageId: "design" },
    });
  });

  it("keeps four-segment envelope paths", () => {
    expect(parseHash("#/runs/r1/stages/design/envelope")).toEqual({
      name: "detail",
      runId: "r1",
      view: { kind: "envelope", stageId: "design" },
    });
  });

  it("round-trips runStagePath through parseHash", () => {
    const path = runStagePath("r1", "design");
    expect(parseHash(`#${path}`)).toEqual({
      name: "detail",
      runId: "r1",
      view: { kind: "stream", stageId: "design" },
    });
  });

  it("yields the unknown stage id from the parser", () => {
    expect(parseHash("#/runs/r1/stages/unknown")).toEqual({
      name: "detail",
      runId: "r1",
      view: { kind: "stream", stageId: "unknown" },
    });
  });
});


describe("eval routes", () => {
  it("round-trips every route through its builder and parser", () => {
    const cases: Array<[string, unknown]> = [
      [evalsPath(), { name: "evals" }],
      [evalsPath({ stage: "triage" }), { name: "evals", stage: "triage" }],
      [evalNewPath(), { name: "evalNew" }],
      [
        evalNewPath({ pipeline: "p/a b.pipeline.yaml", stage: "review" }),
        { name: "evalNew", pipeline: "p/a b.pipeline.yaml", stage: "review" },
      ],
      [evalNewPath({ file: "stages/x.yaml" }), { name: "evalNew", file: "stages/x.yaml" }],
      [evalPath("review-findings"), { name: "evalDetail", evalId: "review-findings" }],
      [evalEditPath("review-findings"), { name: "evalEdit", evalId: "review-findings" }],
      [evalRunPath("e", 14), { name: "evalRun", evalId: "e", runNumber: 14 }],
      [evalRunPath("e", 14, { tab: "graders" }), { name: "evalRun", evalId: "e", runNumber: 14, tab: "graders" }],
      [evalCasePath("e", 14, "c001"), { name: "evalCase", evalId: "e", runNumber: 14, caseId: "c001" }],
      [
        evalCasePath("e", 14, "c 1", { repeat: 0 }),
        { name: "evalCase", evalId: "e", runNumber: 14, caseId: "c 1", repeat: 0 },
      ],
      [evalComparePath("e"), { name: "evalCompare", evalId: "e" }],
      [evalComparePath("e", { a: 13, b: 14 }), { name: "evalCompare", evalId: "e", a: 13, b: 14 }],
      [datasetsPath(), { name: "datasets" }],
      [datasetPath("d1"), { name: "datasetDetail", datasetId: "d1" }],
      [datasetPath("d1", { eval: "e" }), { name: "datasetDetail", datasetId: "d1", evalId: "e" }],
    ];
    for (const [path, route] of cases) expect(parseHash(`#${path}`)).toEqual(route);
  });

  it("round-trips the openRun flag", () => {
    expect(parseHash(`#${evalPath("e", { openRun: true })}`)).toEqual({ name: "evalDetail", evalId: "e", openRun: true });
    expect(parseHash(`#${evalEditPath("e", { openRun: true })}`)).toEqual({ name: "evalEdit", evalId: "e", openRun: true });
    expect(parseHash(`#${evalRunPath("e", 3, { tab: "config", openRun: true })}`)).toEqual({
      name: "evalRun",
      evalId: "e",
      runNumber: 3,
      tab: "config",
      openRun: true,
    });
  });

  it("reads new before an eval id and ignores bad tabs and numbers", () => {
    expect(parseHash("#/evals/new")).toEqual({ name: "evalNew" });
    expect(parseHash("#/evals/e/runs/3?tab=nope")).toEqual({ name: "evalRun", evalId: "e", runNumber: 3 });
    expect(parseHash("#/evals/e/compare?a=x&b=0")).toEqual({ name: "evalCompare", evalId: "e" });
  });

  it("falls back to inbox for malformed eval paths", () => {
    expect(parseHash("#/evals/e/runs/zero")).toEqual({ name: "inbox" });
    expect(parseHash("#/evals/e/unknown")).toEqual({ name: "inbox" });
  });
});
