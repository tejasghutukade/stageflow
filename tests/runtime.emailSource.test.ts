import { describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRunStore } from "../src/runstore/createStore.js";
import {
  EmailSource,
  type EmailClientConfig,
  type EmailImapClient,
  type NormalizedEmailMessage,
} from "../src/runtime/emailSource.js";
import type { TriggerFireEvent } from "../src/runtime/triggerPort.js";
import { clearFindProjectRootCacheForTests } from "../src/project/findProjectRoot.js";
import { initTempGitRepo } from "./helpers/projectContext.js";

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const stageFixture = path.join(fixtures, "stages", "clarify.yaml");
const triggerFixture = (name: string) => path.join(fixtures, "triggers", name);

async function seedCatalog(root: string, triggerFixtureNames: string[]): Promise<void> {
  await mkdir(path.join(root, "pipelines"), { recursive: true });
  await mkdir(path.join(root, "stages"), { recursive: true });
  await mkdir(path.join(root, "tasks"), { recursive: true });
  await mkdir(path.join(root, "triggers"), { recursive: true });

  await writeFile(
    path.join(root, "stageflow.yaml"),
    "version: 1\ncatalog:\n  pipelines:\n    - pipelines\n  tasks:\n    - tasks\n  triggers:\n    - triggers\n",
  );
  await writeFile(
    path.join(root, "pipelines", "hello.pipeline.yaml"),
    "id: hello\nstages:\n  - id: clarify\n    uses: ../stages/clarify.yaml\n",
  );
  await writeFile(path.join(root, "stages", "clarify.yaml"), await readFile(stageFixture, "utf8"));
  await writeFile(
    path.join(root, "tasks", "my-task.task.yaml"),
    "id: my-task\ngoal: Say hello\n",
  );
  for (const name of triggerFixtureNames) {
    await writeFile(path.join(root, "triggers", name), await readFile(triggerFixture(name), "utf8"));
  }
}

async function mkdtempHome(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "sf-email-source-home-"));
}

function makeMessage(overrides: Partial<NormalizedEmailMessage> & { uid: number }): NormalizedEmailMessage {
  return {
    from: "someone@example.com",
    subject: "Hello",
    date: "2026-01-01T00:00:00.000Z",
    text: "body text",
    ...overrides,
  };
}

type FakeClientHandle = {
  client: EmailImapClient;
  connect: ReturnType<typeof vi.fn>;
  fetchNewMessages: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  idle: ReturnType<typeof vi.fn>;
  emitExists: () => void;
  emitClose: () => void;
  emitError: (err: Error) => void;
};

function makeFakeClient(options: {
  uidNext: number;
  fetchImpl: (sinceUid: number) => NormalizedEmailMessage[] | Promise<NormalizedEmailMessage[]>;
}): FakeClientHandle {
  let existsListener: (() => void) | undefined;
  let closeListener: (() => void) | undefined;
  let errorListener: ((err: Error) => void) | undefined;

  const connect = vi.fn(async () => ({ uidNext: options.uidNext }));
  const fetchNewMessages = vi.fn(async (sinceUid: number) => options.fetchImpl(sinceUid));
  const close = vi.fn(async () => {});
  const idle = vi.fn();

  const client: EmailImapClient = {
    connect,
    idle,
    fetchNewMessages,
    close,
    onExists: (listener) => {
      existsListener = listener;
    },
    onClose: (listener) => {
      closeListener = listener;
    },
    onError: (listener) => {
      errorListener = listener;
    },
  };

  return {
    client,
    connect,
    fetchNewMessages,
    close,
    idle,
    emitExists: () => existsListener?.(),
    emitClose: () => closeListener?.(),
    emitError: (err: Error) => errorListener?.(err),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("EmailSource", () => {
  it("fires a dynamic-mode trigger with a correctly-built task for a matching email", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      await seedCatalog(root, ["email-dynamic.trigger.yaml"]);
      clearFindProjectRootCacheForTests();

      const store = createRunStore({ rootDir: await mkdtempHome() });
      const message = makeMessage({ uid: 5, from: "alice@example.com", subject: "Hello", text: "Hi there" });
      const fake = makeFakeClient({ uidNext: 5, fetchImpl: () => [message] });

      const source = new EmailSource({
        store,
        cwd: root,
        env: { EMAIL_PASSWORD: "secret" },
        createEmailClient: () => fake.client,
      });
      const onFire = vi.fn(async (_event: TriggerFireEvent) => {});

      await source.start(onFire);
      expect(fake.connect).toHaveBeenCalledTimes(1);

      fake.emitExists();
      await vi.waitFor(() => expect(onFire).toHaveBeenCalledTimes(1));

      expect(onFire.mock.calls[0][0]).toMatchObject({
        triggerId: "email-dynamic",
        task: {
          id: "email-dynamic-email-5",
          goal: "Handle email: Hello",
          input: { from: "alice@example.com", subject: "Hello", text: "Hi there" },
        },
      });

      await source.stop();
    } finally {
      clearFindProjectRootCacheForTests();
      await cleanup();
    }
  });

  it("does not fire for a non-matching email", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      await seedCatalog(root, ["email-match-invoice.trigger.yaml"]);
      clearFindProjectRootCacheForTests();

      const store = createRunStore({ rootDir: await mkdtempHome() });
      const message = makeMessage({ uid: 3, subject: "Meeting notes" });
      const fake = makeFakeClient({ uidNext: 3, fetchImpl: () => [message] });

      const source = new EmailSource({
        store,
        cwd: root,
        env: { EMAIL_PASSWORD: "secret" },
        createEmailClient: () => fake.client,
      });
      const onFire = vi.fn(async (_event: TriggerFireEvent) => {});

      await source.start(onFire);
      fake.emitExists();
      await vi.waitFor(() => expect(fake.fetchNewMessages).toHaveBeenCalledTimes(1));

      expect(onFire).not.toHaveBeenCalled();

      await source.stop();
    } finally {
      clearFindProjectRootCacheForTests();
      await cleanup();
    }
  });

  it("fires a catalog-mode trigger with no task override", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      await seedCatalog(root, ["email-catalog.trigger.yaml"]);
      clearFindProjectRootCacheForTests();

      const store = createRunStore({ rootDir: await mkdtempHome() });
      const message = makeMessage({ uid: 7 });
      const fake = makeFakeClient({ uidNext: 7, fetchImpl: () => [message] });

      const source = new EmailSource({
        store,
        cwd: root,
        env: { EMAIL_PASSWORD: "secret" },
        createEmailClient: () => fake.client,
      });
      const onFire = vi.fn(async (_event: TriggerFireEvent) => {});

      await source.start(onFire);
      fake.emitExists();
      await vi.waitFor(() => expect(onFire).toHaveBeenCalledTimes(1));

      expect(onFire.mock.calls[0][0]).toEqual({ triggerId: "email-catalog" });

      await source.stop();
    } finally {
      clearFindProjectRootCacheForTests();
      await cleanup();
    }
  });

  it("groups two triggers on the same mailbox into one connection and fires each independently", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      await seedCatalog(root, ["email-match-invoice.trigger.yaml", "email-match-boss.trigger.yaml"]);
      clearFindProjectRootCacheForTests();

      const store = createRunStore({ rootDir: await mkdtempHome() });
      const invoiceMessage = makeMessage({ uid: 10, subject: "Invoice", from: "billing@example.com" });
      const bossMessage = makeMessage({ uid: 11, subject: "Standup notes", from: "boss@example.com" });
      const fake = makeFakeClient({ uidNext: 9, fetchImpl: () => [invoiceMessage, bossMessage] });

      let createCalls = 0;
      const source = new EmailSource({
        store,
        cwd: root,
        env: { EMAIL_PASSWORD: "secret" },
        createEmailClient: () => {
          createCalls += 1;
          return fake.client;
        },
      });
      const onFire = vi.fn(async (_event: TriggerFireEvent) => {});

      await source.start(onFire);
      expect(createCalls).toBe(1);
      expect(fake.connect).toHaveBeenCalledTimes(1);

      fake.emitExists();
      await vi.waitFor(() => expect(onFire).toHaveBeenCalledTimes(2));

      const invoiceCall = onFire.mock.calls.find((call) => call[0].triggerId === "email-match-invoice");
      const bossCall = onFire.mock.calls.find((call) => call[0].triggerId === "email-match-boss");
      expect(invoiceCall?.[0].task?.input).toMatchObject({ subject: "Invoice" });
      expect(bossCall?.[0].task?.input).toMatchObject({ from: "boss@example.com" });

      await source.stop();
    } finally {
      clearFindProjectRootCacheForTests();
      await cleanup();
    }
  });

  it("reconnects after an unexpected disconnect and resumes from the persisted UID watermark", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      await seedCatalog(root, ["email-dynamic.trigger.yaml"]);
      clearFindProjectRootCacheForTests();

      const store = createRunStore({ rootDir: await mkdtempHome() });

      let connectCallCount = 0;
      let current: FakeClientHandle | undefined;
      const createEmailClient = (_config: EmailClientConfig) => {
        connectCallCount += 1;
        const fake = makeFakeClient({
          uidNext: 10,
          fetchImpl: (sinceUid: number) => {
            if (sinceUid === 9) return [makeMessage({ uid: 10, subject: "First" })];
            if (sinceUid === 10) return [makeMessage({ uid: 11, subject: "Second" })];
            return [];
          },
        });
        current = fake;
        return fake.client;
      };

      const source = new EmailSource({
        store,
        cwd: root,
        env: { EMAIL_PASSWORD: "secret" },
        createEmailClient,
        reconnectBaseDelayMs: 5,
        reconnectMaxDelayMs: 20,
      });
      const onFire = vi.fn(async (_event: TriggerFireEvent) => {});

      await source.start(onFire);
      expect(connectCallCount).toBe(1);

      current?.emitExists();
      await vi.waitFor(() => expect(onFire).toHaveBeenCalledTimes(1));
      expect(onFire.mock.calls[0][0].task?.id).toBe("email-dynamic-email-10");

      current?.emitClose();
      await vi.waitFor(() => expect(connectCallCount).toBe(2), { timeout: 2000 });

      current?.emitExists();
      await vi.waitFor(() => expect(onFire).toHaveBeenCalledTimes(2));
      expect(onFire.mock.calls[1][0].task?.id).toBe("email-dynamic-email-11");

      await source.stop();
    } finally {
      clearFindProjectRootCacheForTests();
      await cleanup();
    }
  });

  it("skips a trigger with incomplete event.config (missing secretRef) but still processes a different valid trigger", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      await seedCatalog(root, ["email-missing-secret.trigger.yaml", "email-valid-secondary.trigger.yaml"]);
      clearFindProjectRootCacheForTests();

      const store = createRunStore({ rootDir: await mkdtempHome() });
      const fake = makeFakeClient({ uidNext: 1, fetchImpl: () => [] });
      const logError = vi.fn();

      const source = new EmailSource({
        store,
        cwd: root,
        env: { EMAIL_PASSWORD_2: "secret" },
        createEmailClient: () => fake.client,
        logError,
      });
      const onFire = vi.fn(async (_event: TriggerFireEvent) => {});

      await source.start(onFire);

      expect(fake.connect).toHaveBeenCalledTimes(1);
      expect(logError).toHaveBeenCalledWith(expect.stringContaining("email-missing-secret"));

      await source.stop();
    } finally {
      clearFindProjectRootCacheForTests();
      await cleanup();
    }
  });

  it("stop() closes all connections and cancels pending reconnect timers", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      await seedCatalog(root, ["email-dynamic.trigger.yaml"]);
      clearFindProjectRootCacheForTests();

      const store = createRunStore({ rootDir: await mkdtempHome() });
      let connectCallCount = 0;
      let current: FakeClientHandle | undefined;
      const createEmailClient = () => {
        connectCallCount += 1;
        const fake = makeFakeClient({ uidNext: 1, fetchImpl: () => [] });
        current = fake;
        return fake.client;
      };

      const source = new EmailSource({
        store,
        cwd: root,
        env: { EMAIL_PASSWORD: "secret" },
        createEmailClient,
        reconnectBaseDelayMs: 30,
        reconnectMaxDelayMs: 100,
      });
      const onFire = vi.fn(async (_event: TriggerFireEvent) => {});

      await source.start(onFire);
      expect(connectCallCount).toBe(1);

      current?.emitClose();
      await source.stop();

      expect(current?.close).toHaveBeenCalledTimes(1);

      await sleep(80);
      expect(connectCallCount).toBe(1);
    } finally {
      clearFindProjectRootCacheForTests();
      await cleanup();
    }
  });
});
