import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildSandboxDesk, populateSandboxDesk, syncSandboxDesk } from "../src/runtime/sandboxDesk.js";
import { confineSandboxPath } from "../src/runtime/sandboxFiles.js";
import { SANDBOX_MOUNT_PATH, startSandboxContainer } from "../src/runtime/sandboxContainer.js";
import { writeSandboxFile } from "../src/runtime/sandboxFiles.js";

const fakeDockerBin = fileURLToPath(
  new URL("./fixtures/fakeSandboxDocker.mjs", import.meta.url),
);

describe("buildSandboxDesk", () => {
  it("includes artifacts, an optional envelope, and scratch work, and excludes session files when there is no checkout", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-desk-plain-"));
    const attemptDir = path.join(root, "attempt");
    await mkdir(path.join(attemptDir, ".pi-agent"), { recursive: true });
    await mkdir(path.join(attemptDir, "artifacts"), { recursive: true });
    await writeFile(path.join(attemptDir, "pi-session.jsonl"), "secret-session\n");
    await writeFile(path.join(attemptDir, "log.jsonl"), "secret-log\n");
    await writeFile(path.join(attemptDir, "stream.log"), "secret-stream\n");
    await writeFile(path.join(attemptDir, "envelope.json"), "{}\n");

    const desk = buildSandboxDesk({ attemptDir });
    const hostPaths = desk.bindings.map((binding) => binding.hostPath);

    expect(hostPaths).toContain(path.join(attemptDir, "artifacts"));
    expect(hostPaths).toContain(path.join(attemptDir, "envelope.json"));
    expect(hostPaths).toContain(path.join(attemptDir, "work"));
    expect(desk.bindings.some((binding) => binding.role === "checkout")).toBe(false);
    expect(hostPaths).not.toContain(attemptDir);
    for (const banned of ["pi-session.jsonl", ".pi-agent", "log.jsonl", "stream.log"]) {
      expect(hostPaths).not.toContain(path.join(attemptDir, banned));
    }
    const envelope = desk.bindings.find((binding) => binding.role === "envelope");
    expect(envelope).toMatchObject({
      containerPath: `${SANDBOX_MOUNT_PATH}/envelope.json`,
      copyIn: true,
      copyOut: false,
      optional: true,
    });
    expect(desk.bindings.find((binding) => binding.role === "artifacts")).toMatchObject({
      copyIn: true,
      copyOut: false,
    });
  });

  it("includes the checkout directory only when one is provided", () => {
    const attemptDir = path.join("/tmp", "attempt");
    const checkout = path.join("/tmp", "repo");
    const without = buildSandboxDesk({ attemptDir });
    const withCheckout = buildSandboxDesk({ attemptDir, checkoutRoot: checkout });

    expect(without.bindings.some((binding) => binding.role === "checkout")).toBe(false);
    expect(withCheckout.bindings.find((binding) => binding.role === "checkout")).toMatchObject({
      hostPath: checkout,
      containerPath: `${SANDBOX_MOUNT_PATH}/checkout`,
      copyIn: true,
      copyOut: true,
    });
  });

  it("includes one granted file and does not include its sibling", () => {
    const dir = path.join("/tmp", "grants");
    const note = path.join(dir, "note.txt");
    const sibling = path.join(dir, "other.txt");
    const desk = buildSandboxDesk({
      attemptDir: path.join("/tmp", "attempt"),
      grants: [
        {
          listedPath: "stages/review-pr/attempts/1/artifacts/note.txt",
          hostPath: note,
          containerPath: `${SANDBOX_MOUNT_PATH}/grants/review-pr/note.txt`,
          kind: "file",
        },
      ],
    });
    const hostPaths = desk.bindings.map((binding) => binding.hostPath);
    expect(hostPaths).toContain(note);
    expect(hostPaths).not.toContain(sibling);
    const grant = desk.bindings.find((binding) => binding.role === "grant");
    expect(grant?.containerPath).toBe(`${SANDBOX_MOUNT_PATH}/grants/review-pr/note.txt`);
    expect(grant).toMatchObject({
      shape: "file",
      copyIn: true,
      copyOut: false,
      optional: false,
    });
  });
});

describe("confineSandboxPath", () => {
  it("accepts desk-relative paths and rejects host paths and parent escapes", () => {
    expect(confineSandboxPath("work/hello.txt")).toBe(`${SANDBOX_MOUNT_PATH}/work/hello.txt`);
    expect(confineSandboxPath(`${SANDBOX_MOUNT_PATH}/artifacts/out.txt`)).toBe(
      `${SANDBOX_MOUNT_PATH}/artifacts/out.txt`,
    );
    expect(() => confineSandboxPath("/etc/passwd")).toThrow(/sandbox/);
    expect(() => confineSandboxPath("../etc/passwd")).toThrow(/sandbox/);
    expect(() => confineSandboxPath("work/../../etc/passwd")).toThrow(/sandbox/);
    expect(() => confineSandboxPath(`${SANDBOX_MOUNT_PATH}/../etc/passwd`)).toThrow(/sandbox/);
  });
});

describe("populate and sync sandbox desk", () => {
  it("copies a granted file in, leaves its sibling out, and does not sync grant edits onto the parent host file", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-desk-sync-"));
    const stateDir = path.join(root, "docker-state");
    const attemptDir = path.join(root, "attempt");
    const note = path.join(root, "note.txt");
    const sibling = path.join(root, "other.txt");
    await mkdir(path.join(attemptDir, "artifacts"), { recursive: true });
    await writeFile(path.join(attemptDir, "artifacts", "kept.txt"), "kept\n");
    await writeFile(path.join(attemptDir, "pi-session.jsonl"), "secret-session\n");
    await writeFile(note, "original\n");
    await writeFile(sibling, "sibling\n");
    const previousState = process.env.FAKE_DOCKER_STATE_DIR;
    process.env.FAKE_DOCKER_STATE_DIR = stateDir;
    try {
      const desk = buildSandboxDesk({
        attemptDir,
        grants: [
          {
            listedPath: "stages/review-pr/attempts/1/artifacts/note.txt",
            hostPath: note,
            containerPath: `${SANDBOX_MOUNT_PATH}/grants/review-pr/note.txt`,
            kind: "file",
          },
        ],
      });
      expect(desk.bindings.find((binding) => binding.role === "grant")?.copyOut).toBe(false);
      const { containerName } = await startSandboxContainer({
        image: "stageflow-bash:v1",
        dockerBin: fakeDockerBin,
        runId: "run-1",
        stageId: "work",
        attempt: 1,
      });
      await populateSandboxDesk({
        containerName,
        dockerBin: fakeDockerBin,
        desk,
      });
      const workspace = path.join(stateDir, containerName);
      expect(await readFile(path.join(workspace, "grants", "review-pr", "note.txt"), "utf8")).toBe(
        "original\n",
      );
      expect((await stat(path.join(workspace, "grants", "review-pr", "note.txt"))).isFile()).toBe(
        true,
      );
      expect(await readFile(path.join(workspace, "artifacts", "kept.txt"), "utf8")).toBe("kept\n");
      await expect(readFile(path.join(workspace, "other.txt"), "utf8")).rejects.toThrow();
      await expect(readFile(path.join(workspace, "pi-session.jsonl"), "utf8")).rejects.toThrow();
      await writeSandboxFile(
        { containerName, dockerBin: fakeDockerBin },
        "grants/review-pr/note.txt",
        "edited\n",
      );
      await writeSandboxFile(
        { containerName, dockerBin: fakeDockerBin },
        "work/scratch.txt",
        "scratch\n",
      );
      await writeFile(path.join(attemptDir, "artifacts", "kept.txt"), "published\n");
      await syncSandboxDesk({ containerName, dockerBin: fakeDockerBin, desk });
      expect(await readFile(note, "utf8")).toBe("original\n");
      expect(await readFile(sibling, "utf8")).toBe("sibling\n");
      expect(await readFile(path.join(attemptDir, "work", "scratch.txt"), "utf8")).toBe("scratch\n");
      expect(await readFile(path.join(attemptDir, "artifacts", "kept.txt"), "utf8")).toBe(
        "published\n",
      );
    } finally {
      if (previousState === undefined) delete process.env.FAKE_DOCKER_STATE_DIR;
      else process.env.FAKE_DOCKER_STATE_DIR = previousState;
    }
  });

  it("copies a granted directory as that directory, not a file-named wrapper", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-desk-grant-dir-"));
    const stateDir = path.join(root, "docker-state");
    const attemptDir = path.join(root, "attempt");
    const notes = path.join(root, "notes");
    await mkdir(path.join(attemptDir, "artifacts"), { recursive: true });
    await mkdir(notes, { recursive: true });
    await writeFile(path.join(notes, "a.md"), "a\n");
    const previousState = process.env.FAKE_DOCKER_STATE_DIR;
    process.env.FAKE_DOCKER_STATE_DIR = stateDir;
    try {
      const desk = buildSandboxDesk({
        attemptDir,
        grants: [
          {
            listedPath: "stages/review-pr/attempts/1/artifacts/notes",
            hostPath: notes,
            containerPath: `${SANDBOX_MOUNT_PATH}/grants/review-pr/notes`,
            kind: "directory",
          },
        ],
      });
      const { containerName } = await startSandboxContainer({
        image: "stageflow-bash:v1",
        dockerBin: fakeDockerBin,
        runId: "run-1",
        stageId: "work",
        attempt: 1,
      });
      await populateSandboxDesk({ containerName, dockerBin: fakeDockerBin, desk });
      const copied = path.join(stateDir, containerName, "grants", "review-pr", "notes", "a.md");
      expect(await readFile(copied, "utf8")).toBe("a\n");
      expect((await stat(path.dirname(copied))).isDirectory()).toBe(true);
    } finally {
      if (previousState === undefined) delete process.env.FAKE_DOCKER_STATE_DIR;
      else process.env.FAKE_DOCKER_STATE_DIR = previousState;
    }
  });

  it("mirrors checkout and work deletions and does not wipe a checkout whose container copy is missing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-desk-mirror-"));
    const stateDir = path.join(root, "docker-state");
    const attemptDir = path.join(root, "attempt");
    const checkout = path.join(root, "repo");
    await mkdir(path.join(attemptDir, "work"), { recursive: true });
    await mkdir(checkout, { recursive: true });
    await writeFile(path.join(checkout, "keep.txt"), "keep\n");
    await writeFile(path.join(checkout, "gone.txt"), "gone\n");
    await writeFile(path.join(attemptDir, "work", "old.txt"), "old\n");
    const previousState = process.env.FAKE_DOCKER_STATE_DIR;
    process.env.FAKE_DOCKER_STATE_DIR = stateDir;
    try {
      const desk = buildSandboxDesk({ attemptDir, checkoutRoot: checkout });
      const { containerName } = await startSandboxContainer({
        image: "stageflow-bash:v1",
        dockerBin: fakeDockerBin,
        runId: "run-1",
        stageId: "work",
        attempt: 1,
      });
      await populateSandboxDesk({ containerName, dockerBin: fakeDockerBin, desk });
      const workspace = path.join(stateDir, containerName);
      await rm(path.join(workspace, "checkout", "gone.txt"));
      await writeFile(path.join(workspace, "checkout", "new.txt"), "new\n");
      await writeFile(path.join(workspace, "work", "fresh.txt"), "fresh\n");
      await syncSandboxDesk({ containerName, dockerBin: fakeDockerBin, desk });
      expect(await readFile(path.join(checkout, "keep.txt"), "utf8")).toBe("keep\n");
      expect(await readFile(path.join(checkout, "new.txt"), "utf8")).toBe("new\n");
      await expect(readFile(path.join(checkout, "gone.txt"), "utf8")).rejects.toThrow();
      expect(await readFile(path.join(attemptDir, "work", "fresh.txt"), "utf8")).toBe("fresh\n");
      await expect(readFile(path.join(attemptDir, "work", "old.txt"), "utf8")).rejects.toThrow();

      await rm(path.join(workspace, "checkout"), { recursive: true, force: true });
      await writeFile(path.join(checkout, "still.txt"), "still\n");
      await expect(
        syncSandboxDesk({ containerName, dockerBin: fakeDockerBin, desk }),
      ).rejects.toThrow(/not replacing/);
      expect(await readFile(path.join(checkout, "still.txt"), "utf8")).toBe("still\n");
      expect(await readFile(path.join(checkout, "keep.txt"), "utf8")).toBe("keep\n");
    } finally {
      if (previousState === undefined) delete process.env.FAKE_DOCKER_STATE_DIR;
      else process.env.FAKE_DOCKER_STATE_DIR = previousState;
    }
  });
});
