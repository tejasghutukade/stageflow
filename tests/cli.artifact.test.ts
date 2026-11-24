import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { artifactIdFromRelative, artifactStorageKey, publicArtifactKey, stageOwnerKey } from "../src/artifacts/keys.js";
import { reindexArtifactSearchKey } from "../src/artifacts/search.js";
import {
  runArtifactCommand,
} from "../src/cli/artifactCommand.js";
import { artifactRunShortId } from "../src/cli/artifactListFormat.js";
import { createRunStore, sqliteConnectionFromStore } from "../src/runstore/createStore.js";
import { globalStageflowHome, resetGlobalStageflowHomeForTests } from "../src/project/globalHome.js";
import { attemptArtifactsDir } from "../src/runstore/workspaceLayout.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function seedArtifact(
  projectRoot: string,
  relPath: string,
  contents: string,
): Promise<{ runId: string; workspaceDir: string }> {
  const store = createRunStore({ rootDir: globalStageflowHome() });
  const created = await store.createRun({
    pipelineId: "docs-only",
    taskYaml: "id: a\ngoal: g\n",
    taskId: "a",
  });
  const fullPath = path.join(created.workspaceDir, relPath);
  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, contents);
  return { runId: created.runId, workspaceDir: created.workspaceDir };
}

async function indexEnvelopeArtifacts(
  projectRoot: string,
  options: {
    pipelineId?: string;
    stageId?: string;
    files: Record<string, string>;
    artifacts?: string[];
  },
): Promise<{ runId: string; reportId: string; ownerKey: string; publicKey: string }> {
  const store = createRunStore({ rootDir: globalStageflowHome() });
  const stageId = options.stageId ?? "summarize";
  const pipelineId = options.pipelineId ?? "sales";
  const created = await store.createRun({
    pipelineId,
    taskYaml: "id: t\ngoal: g\n",
    projectRoot,
  });
  await store.createStageExecution(created.runId, stageId);
  const dir = attemptArtifactsDir(store.getWorkspaceDir(created.runId), stageId, 1);
  await mkdir(dir, { recursive: true });
  for (const [rel, body] of Object.entries(options.files)) {
    const full = path.join(dir, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, body);
  }
  const db = sqliteConnectionFromStore(store);
  if (db) {
    db.prepare(`UPDATE runs SET project_root = ? WHERE run_id = ?`).run(projectRoot, created.runId);
  }
  await store.writeEnvelope(
    created.runId,
    stageId,
    {
      status: "success",
      summary: "ok",
      artifacts: options.artifacts ?? Object.keys(options.files),
      payload: {},
    },
    { attempt: 1 },
  );
  const reportId = artifactIdFromRelative("report.md");
  const ownerKey = stageOwnerKey(pipelineId, stageId);
  return {
    runId: created.runId,
    reportId,
    ownerKey,
    publicKey: publicArtifactKey(ownerKey, reportId),
  };
}

function captureIo(): {
  stdout: string[];
  stderr: string[];
  io: { log: (line: string) => void; error: (line: string) => void };
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      log: (line) => stdout.push(line),
      error: (line) => stderr.push(line),
    },
  };
}

describe("runArtifactCommand", () => {
  const previousHome = process.env.STAGEFLOW_HOME;

  beforeEach(async () => {
    resetGlobalStageflowHomeForTests();
    process.env.STAGEFLOW_HOME = await mkdtemp(path.join(tmpdir(), "sf-art-home-"));
    const store = createRunStore({ rootDir: globalStageflowHome() });
    await store.close();
  });

  afterEach(() => {
    resetGlobalStageflowHomeForTests();
    if (previousHome === undefined) {
      delete process.env.STAGEFLOW_HOME;
    } else {
      process.env.STAGEFLOW_HOME = previousHome;
    }
  });

  it("prints artifact contents to stdout", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "sf-art-read-"));
    const rel = path.join("stages", "s1", "out.txt");
    const { runId } = await seedArtifact(projectRoot, rel, "hello artifact");

    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runArtifactCommand(
      ["read", "--run", runId, "--path", rel],
      {
        cwd: projectRoot,
        projectRoot,
        io: {
          log: (line) => stdout.push(line),
          error: (line) => stderr.push(line),
        },
      },
    );

    expect(code).toBe(0);
    expect(stdout.join("\n")).toBe("hello artifact");
    expect(stderr).toEqual([]);
  });

  it("writes artifact to --out and leaves stdout empty", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "sf-art-out-"));
    const rel = path.join("stages", "s1", "out.txt");
    const { runId } = await seedArtifact(projectRoot, rel, "saved content");
    const outFile = path.join(projectRoot, "copied.txt");

    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runArtifactCommand(
      ["read", "--run", runId, "--path", rel, "--out", "copied.txt"],
      {
        cwd: projectRoot,
        projectRoot,
        io: {
          log: (line) => stdout.push(line),
          error: (line) => stderr.push(line),
        },
      },
    );

    expect(code).toBe(0);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toMatch(/Wrote .*copied\.txt/);
    await expect(readFile(outFile, "utf8")).resolves.toBe("saved content");
  });

  it("rejects input path traversal", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "sf-art-in-traversal-"));
    const { runId } = await seedArtifact(projectRoot, "stages/s1/out.txt", "x");

    const stderr: string[] = [];
    const code = await runArtifactCommand(
      ["read", "--run", runId, "--path", "../../etc/passwd"],
      {
        cwd: projectRoot,
        projectRoot,
        io: {
          log: () => undefined,
          error: (line) => stderr.push(line),
        },
      },
    );

    expect(code).toBe(1);
    expect(stderr.join("\n")).toMatch(/path must not contain \.\. segments/);
  });

  it("rejects output path traversal", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "sf-art-out-traversal-"));
    const rel = path.join("stages", "s1", "out.txt");
    const { runId } = await seedArtifact(projectRoot, rel, "x");

    const stderr: string[] = [];
    const code = await runArtifactCommand(
      [
        "read",
        "--run",
        runId,
        "--path",
        rel,
        "--out",
        "../../../etc/passwd",
      ],
      {
        cwd: projectRoot,
        projectRoot,
        io: {
          log: () => undefined,
          error: (line) => stderr.push(line),
        },
      },
    );

    expect(code).toBe(1);
    expect(stderr.join("\n")).toMatch(/path must not contain \.\. segments/);
  });

  it("denies .pi-agent/auth.json paths", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "sf-art-deny-"));
    const rel = path.join("stages", "s1", ".pi-agent", "auth.json");
    const { runId } = await seedArtifact(
      projectRoot,
      rel,
      JSON.stringify({ secret: "nope" }),
    );

    const stderr: string[] = [];
    const code = await runArtifactCommand(
      ["read", "--run", runId, "--path", rel],
      {
        cwd: projectRoot,
        projectRoot,
        io: {
          log: () => undefined,
          error: (line) => stderr.push(line),
        },
      },
    );

    expect(code).toBe(1);
    expect(stderr.join("\n")).toMatch(/Artifact path denied/);
  });

  it("exits 1 for unknown run", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "sf-art-unknown-run-"));

    const stderr: string[] = [];
    const code = await runArtifactCommand(
      ["read", "--run", "missing-run-id", "--path", "stages/s1/out.txt"],
      {
        cwd: projectRoot,
        projectRoot,
        io: {
          log: () => undefined,
          error: (line) => stderr.push(line),
        },
      },
    );

    expect(code).toBe(1);
    expect(stderr.join("\n")).toMatch(/Run not found: missing-run-id/);
  });

  it("prints usage when --path is missing", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "sf-art-missing-path-"));
    const { runId } = await seedArtifact(projectRoot, "stages/s1/out.txt", "x");

    const stderr: string[] = [];
    const code = await runArtifactCommand(["read", "--run", runId], {
      cwd: projectRoot,
      projectRoot,
      io: {
        log: () => undefined,
        error: (line) => stderr.push(line),
      },
    });

    expect(code).toBe(1);
    expect(stderr.join("\n")).toMatch(/Missing --run and\/or --path/);
    expect(stderr.join("\n")).toMatch(/sf artifact read/);
  });

  it("lists indexed artifacts in a table", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "sf-art-list-"));
    const { publicKey, runId } = await indexEnvelopeArtifacts(projectRoot, {
      files: { "report.md": "# report", "notes.txt": "skip me" },
      artifacts: ["report.md"],
    });
    const { stdout, stderr, io } = captureIo();
    const code = await runArtifactCommand(["list"], {
      cwd: projectRoot,
      projectRoot,
      io,
    });
    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    const text = stdout.join("\n");
    expect(text).toMatch(/KEY/);
    expect(text).toMatch(/KIND/);
    expect(text).toMatch(/TITLE/);
    expect(text).toMatch(/STATUS/);
    expect(text).toContain(publicKey);
    expect(text).toContain("static.markdown");
    expect(text).toContain("report.md");
    expect(text).not.toContain("notes.txt");
    const shortRun = artifactRunShortId(runId);
    expect(shortRun).not.toBe(runId.slice(0, 8));
    expect(shortRun).not.toMatch(/^\d{4}-\d{2}-/);
    expect(text).toContain(shortRun);
    expect(artifactRunShortId("a1b2c3d4-e5f6-7890-abcd-ef1234567890")).toBe("a1b2c3d4");
    expect(artifactRunShortId("2026-11-24T17-58-00-000Z-ab12cd")).not.toBe("2026-11-");
  });

  it("list human output marks an expired row", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "sf-art-list-expired-"));
    const { publicKey } = await indexEnvelopeArtifacts(projectRoot, {
      files: { "report.md": "# report" },
      artifacts: ["report.md"],
    });
    const store = createRunStore({ rootDir: globalStageflowHome() });
    const db = sqliteConnectionFromStore(store)!;
    db.prepare(`UPDATE artifacts SET status = 'expired', expired_reason = 'run_deleted', expired_at = ?`).run(
      "2026-06-01T00:00:00.000Z",
    );
    await store.close();
    const { stdout, io } = captureIo();
    expect(await runArtifactCommand(["list"], { cwd: projectRoot, projectRoot, io })).toBe(0);
    const text = stdout.join("\n");
    expect(text).toContain(publicKey);
    expect(text).toContain("expired");
  });

  it("list --json returns the API page shape", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "sf-art-list-json-"));
    await indexEnvelopeArtifacts(projectRoot, {
      files: { "report.md": "# report" },
      artifacts: ["report.md"],
    });
    const { stdout, io } = captureIo();
    const code = await runArtifactCommand(["list", "--json"], {
      cwd: projectRoot,
      projectRoot,
      io,
    });
    expect(code).toBe(0);
    const body = JSON.parse(stdout.join("\n"));
    expect(body).toEqual({
      artifacts: [
        expect.objectContaining({
          title: "report.md",
          kind: "static.markdown",
          source: expect.objectContaining({ run_id: expect.any(String) }),
        }),
      ],
      next_cursor: null,
    });
  });

  it("list filters by kind, owner, --q, and --live", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "sf-art-list-filter-"));
    await indexEnvelopeArtifacts(projectRoot, {
      pipelineId: "sales",
      stageId: "summarize",
      files: { "report.md": "a", "data.csv": "b" },
      artifacts: ["report.md", "data.csv"],
    });
    const store = createRunStore({ rootDir: globalStageflowHome() });
    const db = sqliteConnectionFromStore(store)!;
    db.prepare(`UPDATE artifacts SET kind = 'live.declarative' WHERE title = 'data.csv'`).run();

    const { stdout: kindOut, io: kindIo } = captureIo();
    expect(
      await runArtifactCommand(["list", "--kind", "static.markdown", "--json"], {
        cwd: projectRoot,
        projectRoot,
        io: kindIo,
      }),
    ).toBe(0);
    const kindBody = JSON.parse(kindOut.join("\n"));
    expect(kindBody.artifacts.map((row: { title: string }) => row.title)).toEqual(["report.md"]);

    const { stdout: ownerOut, io: ownerIo } = captureIo();
    expect(
      await runArtifactCommand(["list", "--owner", "sales:summarize", "--json"], {
        cwd: projectRoot,
        projectRoot,
        io: ownerIo,
      }),
    ).toBe(0);
    expect(JSON.parse(ownerOut.join("\n")).artifacts).toHaveLength(2);

    const { stdout: qOut, io: qIo } = captureIo();
    expect(
      await runArtifactCommand(["list", "--q", "report", "--json"], {
        cwd: projectRoot,
        projectRoot,
        io: qIo,
      }),
    ).toBe(0);
    expect(JSON.parse(qOut.join("\n")).artifacts).toHaveLength(1);

    const { stdout: liveOut, io: liveIo } = captureIo();
    expect(
      await runArtifactCommand(["list", "--live", "--json"], {
        cwd: projectRoot,
        projectRoot,
        io: liveIo,
      }),
    ).toBe(0);
    expect(JSON.parse(liveOut.join("\n")).artifacts.map((row: { title: string }) => row.title)).toEqual([
      "data.csv",
    ]);
  });

  it("sends kind, owner, tag, status, sort, and order to the index", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "sf-art-list-server-"));
    await indexEnvelopeArtifacts(projectRoot, {
      pipelineId: "sales",
      stageId: "summarize",
      files: { "report.md": "a", "data.csv": "b" },
      artifacts: ["report.md", "data.csv"],
    });
    const store = createRunStore({ rootDir: globalStageflowHome() });
    const db = sqliteConnectionFromStore(store)!;
    db.prepare(`UPDATE artifacts SET tags_json = '["weekly"]' WHERE title = 'report.md'`).run();
    db.prepare(`UPDATE artifacts SET status = 'expired', expired_reason = 'run_deleted' WHERE title = 'data.csv'`).run();
    await store.close();

    const { stdout: tagOut, io: tagIo } = captureIo();
    expect(
      await runArtifactCommand(["list", "--tag", "weekly", "--json"], { cwd: projectRoot, projectRoot, io: tagIo }),
    ).toBe(0);
    expect(JSON.parse(tagOut.join("\n")).artifacts.map((row: { title: string }) => row.title)).toEqual(["report.md"]);

    const { stdout: statusOut, io: statusIo } = captureIo();
    expect(
      await runArtifactCommand(["list", "--status", "expired", "--json"], {
        cwd: projectRoot,
        projectRoot,
        io: statusIo,
      }),
    ).toBe(0);
    expect(JSON.parse(statusOut.join("\n")).artifacts.map((row: { title: string }) => row.title)).toEqual(["data.csv"]);

    const { stdout: sortOut, io: sortIo } = captureIo();
    expect(
      await runArtifactCommand(["list", "--sort", "title", "--order", "asc", "--json"], {
        cwd: projectRoot,
        projectRoot,
        io: sortIo,
      }),
    ).toBe(0);
    expect(JSON.parse(sortOut.join("\n")).artifacts.map((row: { title: string }) => row.title)).toEqual([
      "data.csv",
      "report.md",
    ]);

    const { stdout: badOut, stderr: badErr, io: badIo } = captureIo();
    expect(
      await runArtifactCommand(["list", "--sort", "nope", "--json"], { cwd: projectRoot, projectRoot, io: badIo }),
    ).toBe(1);
    expect(JSON.parse(badOut.join("\n")).code).toBe("artifact.invalid_filter");
    expect(badErr).toEqual([]);
  });

  it("passes --q to the index and finds a renamed artifact", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "sf-art-list-q-"));
    await indexEnvelopeArtifacts(projectRoot, {
      files: { "report.md": "a" },
      artifacts: ["report.md"],
    });
    const store = createRunStore({ rootDir: globalStageflowHome() });
    const db = sqliteConnectionFromStore(store)!;
    const sample = db.prepare(`SELECT * FROM artifacts LIMIT 1`).get() as Record<string, unknown>;
    db.prepare(`UPDATE artifacts SET title = 'needle-report', updated_at = '2020-01-01T00:00:00.000Z'`).run();
    const renamed = db.prepare(`SELECT key FROM artifacts WHERE title = 'needle-report'`).get() as { key: string };
    reindexArtifactSearchKey(db, renamed.key, "a");
    const insertColumns = Object.keys(sample);
    const insert = db.prepare(
      `INSERT INTO artifacts (${insertColumns.join(", ")}) VALUES (${insertColumns.map((column) => `@${column}`).join(", ")})`,
    );
    for (let index = 0; index < 100; index++) {
      const id = `filler${index}`;
      insert.run({
        ...sample,
        key: artifactStorageKey(String(sample.project_root_id), stageOwnerKey("sales", "summarize"), id),
        id,
        title: `filler ${index}`,
        updated_at: `2027-01-01T00:00:00.${String(index).padStart(3, "0")}Z`,
        created_at: `2027-01-01T00:00:00.${String(index).padStart(3, "0")}Z`,
      });
    }
    await store.close();
    const { stdout, io } = captureIo();
    expect(
      await runArtifactCommand(["list", "--q", "needle", "--limit", "1", "--json"], {
        cwd: projectRoot,
        projectRoot,
        io,
      }),
    ).toBe(0);
    const body = JSON.parse(stdout.join("\n"));
    expect(body.artifacts.map((row: { title: string }) => row.title)).toEqual(["needle-report"]);
    expect(body.next_cursor).toBeNull();
  });

  it("list --limit caps rows and reports an empty index", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "sf-art-list-limit-"));
    await indexEnvelopeArtifacts(projectRoot, {
      files: { "a.md": "1", "b.md": "2", "c.md": "3" },
      artifacts: ["a.md", "b.md", "c.md"],
    });
    const { stdout, io } = captureIo();
    expect(
      await runArtifactCommand(["list", "--limit", "2", "--json"], {
        cwd: projectRoot,
        projectRoot,
        io,
      }),
    ).toBe(0);
    expect(JSON.parse(stdout.join("\n")).artifacts).toHaveLength(2);

    resetGlobalStageflowHomeForTests();
    const emptyHome = await mkdtemp(path.join(tmpdir(), "sf-art-list-empty-"));
    process.env.STAGEFLOW_HOME = emptyHome;
    const emptyStore = createRunStore({ rootDir: emptyHome });
    await emptyStore.close();
    const { stdout: emptyOut, io: emptyIo } = captureIo();
    expect(await runArtifactCommand(["list"], { cwd: projectRoot, projectRoot, io: emptyIo })).toBe(0);
    expect(emptyOut.join("\n")).toBe("No artifacts.");
  });

  it("show prints one record and supports --json", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "sf-art-show-"));
    const { publicKey, runId } = await indexEnvelopeArtifacts(projectRoot, {
      files: { "report.md": "body" },
      artifacts: ["report.md"],
    });
    const { stdout, io } = captureIo();
    expect(
      await runArtifactCommand(["show", publicKey], {
        cwd: projectRoot,
        projectRoot,
        io,
      }),
    ).toBe(0);
    const human = stdout.join("\n");
    expect(human).toContain("title: report.md");
    expect(human).toContain("kind: static.markdown");
    expect(human).toContain("status: available");
    expect(human).toContain("owner: sales:summarize");
    expect(human).toContain(`source: ${runId} summarize attempt 1`);
    expect(human).toContain("updated:");
    expect(human).toContain("expires:");
    expect(human).not.toContain("\"key\"");

    const { stdout: jsonOut, io: jsonIo } = captureIo();
    expect(
      await runArtifactCommand(["show", publicKey, "--json"], {
        cwd: projectRoot,
        projectRoot,
        io: jsonIo,
      }),
    ).toBe(0);
    const body = JSON.parse(jsonOut.join("\n"));
    expect(body.title).toBe("report.md");
    expect(body.source.run_id).toBe(runId);
    expect(body.status).toBe("available");
  });

  it("show human output names an expired reason", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "sf-art-show-expired-"));
    const { publicKey } = await indexEnvelopeArtifacts(projectRoot, {
      files: { "report.md": "body" },
      artifacts: ["report.md"],
    });
    const store = createRunStore({ rootDir: globalStageflowHome() });
    const db = sqliteConnectionFromStore(store)!;
    db.prepare(`UPDATE artifacts SET status = 'expired', expired_reason = 'file_missing', expired_at = ?`).run(
      "2026-06-01T00:00:00.000Z",
    );
    await store.close();
    const { stdout, io } = captureIo();
    expect(await runArtifactCommand(["show", publicKey], { cwd: projectRoot, projectRoot, io })).toBe(0);
    const text = stdout.join("\n");
    expect(text).toContain("status: expired");
    expect(text).toContain("expired: file_missing");
    const { stdout: jsonOut, io: jsonIo } = captureIo();
    expect(
      await runArtifactCommand(["show", publicKey, "--json"], { cwd: projectRoot, projectRoot, io: jsonIo }),
    ).toBe(0);
    expect(JSON.parse(jsonOut.join("\n")).expired_reason).toBe("file_missing");
  });

  it("show exits 1 for an unknown key", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "sf-art-show-missing-"));
    await indexEnvelopeArtifacts(projectRoot, { files: { "report.md": "x" }, artifacts: ["report.md"] });
    const { stdout, stderr, io } = captureIo();
    const code = await runArtifactCommand(
      ["show", "stage:sales:summarize/missing_id_00000000", "--json"],
      { cwd: projectRoot, projectRoot, io },
    );
    expect(code).toBe(1);
    expect(JSON.parse(stdout.join("\n"))).toEqual({
      error: "Artifact not found",
      code: "artifact.not_found",
    });
    expect(stderr).toEqual([]);
  });

  it("show exits 1 with project roots when the key is ambiguous", async () => {
    const alpha = await mkdtemp(path.join(tmpdir(), "sf-art-cli-a-"));
    const beta = await mkdtemp(path.join(tmpdir(), "sf-art-cli-b-"));
    const first = await indexEnvelopeArtifacts(alpha, { files: { "report.md": "a" }, artifacts: ["report.md"] });
    await indexEnvelopeArtifacts(beta, { files: { "report.md": "b" }, artifacts: ["report.md"] });
    const { stderr, io } = captureIo();
    const code = await runArtifactCommand(["show", first.publicKey], {
      cwd: alpha,
      projectRoot: alpha,
      io,
    });
    expect(code).toBe(1);
    expect(stderr.join("\n")).toMatch(/artifact\.ambiguous|more than one project/i);
    const rootsLine = stderr.join("\n");
    expect(rootsLine).toContain(path.basename(alpha));
    expect(rootsLine).toContain(path.basename(beta));
  });

  it("reports usage for unknown subcommands and missing show key", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "sf-art-usage-"));
    const { stderr: badSub, io: badIo } = captureIo();
    expect(await runArtifactCommand(["nope"], { cwd: projectRoot, projectRoot, io: badIo })).toBe(1);
    expect(badSub.join("\n")).toMatch(/Unknown artifact subcommand/);

    const { stderr: missingKey, io: keyIo } = captureIo();
    expect(await runArtifactCommand(["show"], { cwd: projectRoot, projectRoot, io: keyIo })).toBe(1);
    expect(missingKey.join("\n")).toMatch(/Missing artifact key/);
  });

  it("publishes from --file and --stdin and deletes with and without --yes", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "sf-art-pub-"));
    const home = globalStageflowHome();
    const store = createRunStore({ rootDir: home });
    await store.ensureProject(projectRoot);
    await store.close();
    const file = path.join(projectRoot, "note.md");
    await writeFile(file, "# from file\n");
    const { stdout, io } = captureIo();
    const published = await runArtifactCommand(
      [
        "publish",
        "--owner",
        "sales:summarize",
        "--id",
        "weekly",
        "--kind",
        "static.markdown",
        "--title",
        "Weekly",
        "--file",
        file,
        "--project-root",
        projectRoot,
        "--json",
      ],
      { cwd: projectRoot, projectRoot, io },
    );
    expect(published).toBe(0);
    const body = JSON.parse(stdout.join("\n")) as { key: string; version: number; unchanged: boolean };
    expect(body).toMatchObject({ key: "stage:sales:summarize/weekly", version: 1, unchanged: false });

    const again = captureIo();
    const republish = await runArtifactCommand(
      [
        "publish",
        "--owner",
        "sales:summarize",
        "--id",
        "notes",
        "--kind",
        "static.text",
        "--title",
        "Notes",
        "--stdin",
        "--project-root",
        projectRoot,
        "--json",
      ],
      {
        cwd: projectRoot,
        projectRoot,
        io: again.io,
        readStdin: async () => Buffer.from("from stdin"),
      },
    );
    expect(republish).toBe(0);
    expect(JSON.parse(again.stdout.join("\n")).version).toBe(1);

    const refused = captureIo();
    const no = await runArtifactCommand(
      ["delete", body.key, "--project-root", projectRoot, "--json"],
      { cwd: projectRoot, projectRoot, io: refused.io, stdinIsTTY: false },
    );
    expect(no).toBe(1);
    expect(JSON.parse(refused.stdout.join("\n")).code).toBe("artifact.confirmation_required");

    const removed = captureIo();
    const yes = await runArtifactCommand(
      ["delete", body.key, "--project-root", projectRoot, "--yes", "--json"],
      { cwd: projectRoot, projectRoot, io: removed.io },
    );
    expect(yes).toBe(0);
    expect(JSON.parse(removed.stdout.join("\n")).key).toBe(body.key);

    const cancelled = captureIo();
    const declined = await runArtifactCommand(
      ["delete", "stage:sales:summarize/notes", "--project-root", projectRoot, "--json"],
      { cwd: projectRoot, projectRoot, io: cancelled.io, confirm: async () => false },
    );
    expect(declined).toBe(1);
    const accepted = captureIo();
    const confirmed = await runArtifactCommand(
      ["delete", "stage:sales:summarize/notes", "--project-root", projectRoot, "--json"],
      { cwd: projectRoot, projectRoot, io: accepted.io, confirm: async () => true },
    );
    expect(confirmed).toBe(0);
  });
});
