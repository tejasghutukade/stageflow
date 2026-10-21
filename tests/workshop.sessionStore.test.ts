import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  appendWorkshopSessionMessages,
  createWorkshopSession,
  getWorkshopSession,
  listWorkshopSessions,
  parseWorkshopSessionRecord,
  resolveWorkshopSessionStoreRoot,
  truncateWorkshopSessionTitle,
  updateWorkshopSessionPiSessionId,
  workshopSessionFilePath,
  workshopSessionPiFilePath,
  workshopSessionsDir,
  WORKSHOP_SESSION_TITLE_MAX_LENGTH,
  WorkshopSessionStoreError,
} from "../src/workshop/sessionStore.js";
import { withIsolatedHome } from "./helpers/projectContext.js";

describe("workshop session store", () => {
  it("resolves store root under STAGEFLOW_HOME and keeps sessions under workshop/sessions", async () => {
    await withIsolatedHome(async (home) => {
      const storeRoot = resolveWorkshopSessionStoreRoot();
      expect(storeRoot).toBe(path.join(home, ".stageflow"));
      expect(workshopSessionsDir(storeRoot)).toBe(
        path.join(storeRoot, "workshop", "sessions"),
      );
    });
  });

  it("creates a session with empty title and no draft field on disk", async () => {
    await withIsolatedHome(async () => {
      const storeRoot = resolveWorkshopSessionStoreRoot();
      const created = createWorkshopSession(storeRoot, {
        id: "sess-a",
        now: new Date("2026-09-29T12:00:00.000Z"),
      });

      expect(created).toEqual({
        version: 1,
        id: "sess-a",
        title: "",
        createdAt: "2026-09-29T12:00:00.000Z",
        updatedAt: "2026-09-29T12:00:00.000Z",
        transcript: [],
        piSessionId: null,
      });
      expect(created).not.toHaveProperty("draft");

      const filePath = workshopSessionFilePath(storeRoot, "sess-a");
      expect(existsSync(filePath)).toBe(true);
      const raw = JSON.parse(readFileSync(filePath, "utf8")) as Record<
        string,
        unknown
      >;
      expect(raw).not.toHaveProperty("draft");
      expect(raw.transcript).toEqual([]);
      expect(workshopSessionPiFilePath(storeRoot, "sess-a")).toBe(
        path.join(storeRoot, "workshop", "sessions", "sess-a", "pi-session.jsonl"),
      );
    });
  });

  it("appends messages, sets title from first user message, and lists by updatedAt", async () => {
    await withIsolatedHome(async () => {
      const storeRoot = resolveWorkshopSessionStoreRoot();
      createWorkshopSession(storeRoot, {
        id: "older",
        now: new Date("2026-09-29T10:00:00.000Z"),
      });
      createWorkshopSession(storeRoot, {
        id: "newer",
        now: new Date("2026-09-29T11:00:00.000Z"),
      });

      const afterAssistant = appendWorkshopSessionMessages(
        storeRoot,
        "newer",
        [{ id: "m0", role: "assistant", text: "What are we building?" }],
        { now: new Date("2026-09-29T11:01:00.000Z") },
      );
      expect(afterAssistant.title).toBe("");
      expect(afterAssistant.transcript).toHaveLength(1);

      const afterUser = appendWorkshopSessionMessages(
        storeRoot,
        "newer",
        [
          {
            id: "m1",
            role: "user",
            text: "  Build a release checklist pipeline  ",
          },
          { id: "m2", role: "assistant", text: "Got it." },
        ],
        { now: new Date("2026-09-29T11:02:00.000Z") },
      );
      expect(afterUser.title).toBe("Build a release checklist pipeline");
      expect(afterUser.transcript.map((m) => m.id)).toEqual(["m0", "m1", "m2"]);

      appendWorkshopSessionMessages(
        storeRoot,
        "older",
        [{ role: "user", text: "later bump" }],
        { now: new Date("2026-09-29T12:00:00.000Z") },
      );

      const listed = listWorkshopSessions(storeRoot);
      expect(listed.map((s) => s.id)).toEqual(["older", "newer"]);
      expect(listed[0]?.title).toBe("later bump");
      expect(listed[1]?.title).toBe("Build a release checklist pipeline");

      const loaded = getWorkshopSession(storeRoot, "newer");
      expect(loaded.transcript).toHaveLength(3);
      expect(loaded).not.toHaveProperty("draft");
    });
  });

  it("truncates title from the first user message and leaves title empty until then", async () => {
    await withIsolatedHome(async () => {
      const storeRoot = resolveWorkshopSessionStoreRoot();
      createWorkshopSession(storeRoot, { id: "t1" });

      const long = "x".repeat(WORKSHOP_SESSION_TITLE_MAX_LENGTH + 40);
      expect(truncateWorkshopSessionTitle(long).length).toBe(
        WORKSHOP_SESSION_TITLE_MAX_LENGTH,
      );

      appendWorkshopSessionMessages(storeRoot, "t1", [
        { role: "assistant", text: "hello" },
      ]);
      expect(getWorkshopSession(storeRoot, "t1").title).toBe("");

      const withTitle = appendWorkshopSessionMessages(storeRoot, "t1", [
        { role: "user", text: long },
      ]);
      expect(withTitle.title).toBe(
        "x".repeat(WORKSHOP_SESSION_TITLE_MAX_LENGTH),
      );

      const secondUser = appendWorkshopSessionMessages(storeRoot, "t1", [
        { role: "user", text: "should not replace title" },
      ]);
      expect(secondUser.title).toBe(withTitle.title);
    });
  });

  it("returns structured not-found for missing session ids", async () => {
    await withIsolatedHome(async () => {
      const storeRoot = resolveWorkshopSessionStoreRoot();
      expect(() => getWorkshopSession(storeRoot, "missing")).toThrow(
        WorkshopSessionStoreError,
      );
      try {
        getWorkshopSession(storeRoot, "missing");
        expect.unreachable("expected throw");
      } catch (err) {
        expect(err).toBeInstanceOf(WorkshopSessionStoreError);
        const typed = err as WorkshopSessionStoreError;
        expect(typed.code).toBe("workshop_session_not_found");
        expect(typed.sessionId).toBe("missing");
      }

      expect(() =>
        appendWorkshopSessionMessages(storeRoot, "missing", [
          { role: "user", text: "hi" },
        ]),
      ).toThrow(WorkshopSessionStoreError);

      expect(listWorkshopSessions(storeRoot)).toEqual([]);
    });
  });

  it("updates piSessionId without storing a draft", async () => {
    await withIsolatedHome(async () => {
      const storeRoot = resolveWorkshopSessionStoreRoot();
      createWorkshopSession(storeRoot, { id: "pi-1" });
      const updated = updateWorkshopSessionPiSessionId(
        storeRoot,
        "pi-1",
        "pi-abc",
        { now: new Date("2026-09-29T13:00:00.000Z") },
      );
      expect(updated.piSessionId).toBe("pi-abc");
      expect(updated.updatedAt).toBe("2026-09-29T13:00:00.000Z");
      expect(JSON.parse(readFileSync(workshopSessionFilePath(storeRoot, "pi-1"), "utf8"))).not.toHaveProperty(
        "draft",
      );
    });
  });

  it("a session file with no activeBuildId loads as unlinked and still appears in the session list", async () => {
    await withIsolatedHome(async () => {
      const storeRoot = resolveWorkshopSessionStoreRoot();
      const legacy = {
        version: 1,
        id: "legacy-unlinked",
        title: "older chat",
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-01T00:00:00.000Z",
        transcript: [],
        piSessionId: null,
      };
      const dir = path.join(storeRoot, "workshop", "sessions", "legacy-unlinked");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        path.join(dir, "session.json"),
        `${JSON.stringify(legacy, null, 2)}\n`,
        "utf8",
      );

      const loaded = getWorkshopSession(storeRoot, "legacy-unlinked");
      expect(loaded.version).toBe(1);
      expect(loaded.activeBuildId).toBeUndefined();
      expect(loaded.title).toBe("older chat");

      const listed = listWorkshopSessions(storeRoot);
      expect(listed.map((session) => session.id)).toContain("legacy-unlinked");
    });
  });

  it("parses version 1 and copies activeBuildId, treating a missing field as unlinked", () => {
    const base = {
      version: 1,
      id: "sess-parse",
      title: "",
      createdAt: "2026-10-01T12:00:00.000Z",
      updatedAt: "2026-10-01T12:00:00.000Z",
      transcript: [],
      piSessionId: null,
    };

    const linked = parseWorkshopSessionRecord({
      ...base,
      activeBuildId: "build-9",
    });
    expect(linked?.version).toBe(1);
    expect(linked?.activeBuildId).toBe("build-9");

    const unlinked = parseWorkshopSessionRecord(base);
    expect(unlinked?.version).toBe(1);
    expect(unlinked?.activeBuildId).toBeUndefined();
  });

  it("appending a transcript message to a session whose activeBuildId is set leaves that id in the file", async () => {
    await withIsolatedHome(async () => {
      const storeRoot = resolveWorkshopSessionStoreRoot();
      const seeded = {
        version: 1,
        id: "sess-linked",
        title: "",
        createdAt: "2026-10-01T12:00:00.000Z",
        updatedAt: "2026-10-01T12:00:00.000Z",
        transcript: [],
        piSessionId: null,
        activeBuildId: "build-keep",
      };
      const dir = path.join(storeRoot, "workshop", "sessions", "sess-linked");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        workshopSessionFilePath(storeRoot, "sess-linked"),
        `${JSON.stringify(seeded, null, 2)}\n`,
        "utf8",
      );

      const appended = appendWorkshopSessionMessages(
        storeRoot,
        "sess-linked",
        [{ id: "m1", role: "user", text: "keep the pipeline" }],
        { now: new Date("2026-10-01T12:05:00.000Z") },
      );

      expect(appended.version).toBe(1);
      expect(appended.activeBuildId).toBe("build-keep");
      expect(appended.transcript.map((message) => message.id)).toEqual(["m1"]);

      const raw = JSON.parse(
        readFileSync(workshopSessionFilePath(storeRoot, "sess-linked"), "utf8"),
      ) as Record<string, unknown>;
      expect(raw.version).toBe(1);
      expect(raw.activeBuildId).toBe("build-keep");
      expect(getWorkshopSession(storeRoot, "sess-linked").activeBuildId).toBe(
        "build-keep",
      );
    });
  });
});
