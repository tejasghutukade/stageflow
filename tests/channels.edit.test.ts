import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ChannelSecretStore } from "../src/channels/secretStore.js";
import { addConnectionYaml, removeConnectionYaml, updateConnectionYaml } from "../src/channels/configWriter.js";
import { resolveSecretRef } from "../src/channels/secrets.js";
import { connectionsFilePath } from "../src/channels/registry.js";
import { startChannelService, type ChannelService } from "../src/channels/service.js";
import { channelHostFor, releaseChannelHost } from "../src/channels/host.js";
import { registerChannelProvider, unregisterChannelProvider } from "../src/channels/providers.js";
import { ChannelError } from "../src/channels/errors.js";
import { fakeChannelProvider } from "./fixtures/fakeChannelProvider.js";

const SECRET = "super-secret-token-value";
let home: string;
let cwd: string;
let credentialRoot: string;
const previous = process.env.STAGEFLOW_CREDENTIAL_HOME;
beforeAll(async () => {
  credentialRoot = await mkdtemp(path.join(tmpdir(), "sf-cred-"));
  process.env.STAGEFLOW_CREDENTIAL_HOME = credentialRoot;
});
afterAll(async () => {
  if (previous === undefined) delete process.env.STAGEFLOW_CREDENTIAL_HOME; else process.env.STAGEFLOW_CREDENTIAL_HOME = previous;
  await rm(credentialRoot, { recursive: true, force: true });
});

describe("secret store", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), "sf-store-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("stores owner-only, round-trips, deletes and deletes by prefix", async () => {
    const file = path.join(dir, "nested", "channel-secrets.json");
    const store = new ChannelSecretStore(file);
    store.set("connection.a.token", "one");
    store.set("connection.a.extra", "two");
    store.set("connection.b.token", "three");
    expect(store.get("connection.a.token")).toBe("one");
    expect(((await stat(file)).mode & 0o777).toString(8)).toBe("600");
    store.deleteWithPrefix("connection.a.");
    expect(store.get("connection.a.token")).toBeUndefined();
    expect(store.get("connection.b.token")).toBe("three");
    store.delete("connection.b.token");
    expect(store.has("connection.b.token")).toBe(false);
  });

  it.each([["bad name"], ["../x"], [""]])("rejects the name %j and bad values", (name) => {
    const store = new ChannelSecretStore(path.join(dir, "s.json"));
    expect(() => store.set(name, "v")).toThrow("CHANNEL_INVALID_INPUT");
    expect(() => store.set("ok.name", "line\nbreak")).toThrow("CHANNEL_INVALID_INPUT");
    expect(() => store.set("ok.name", "")).toThrow("CHANNEL_INVALID_INPUT");
  });

  it("fails closed on a corrupt file", async () => {
    const file = path.join(dir, "s.json");
    await writeFile(file, "{not json");
    expect(() => new ChannelSecretStore(file).get("x")).toThrow("CHANNEL_STORAGE_FAILED");
  });

  it("resolves store: references and reports a missing one without leaking", () => {
    const store = new ChannelSecretStore(path.join(dir, "s.json"));
    store.set("connection.a.token", SECRET);
    expect(resolveSecretRef("store:connection.a.token", {}, { connectionId: "a", field: "token" }, store)).toBe(SECRET);
    const error = (() => { try { resolveSecretRef("store:nope", {}, { connectionId: "a", field: "token" }, store); } catch (e) { return e as ChannelError; } })();
    expect(error).toMatchObject({ code: "CHANNEL_SECRET_UNAVAILABLE" });
    expect(() => resolveSecretRef("store:x", {}, { connectionId: "a", field: "token" })).toThrow("CHANNEL_SECRET_UNAVAILABLE");
  });
});

describe("connections.yaml editing", () => {
  const base = "# my connections\nversion: 1\nconnections:\n  - id: a\n    provider: fake\n    secrets: { token: env:A_TOKEN }  # keep\n";

  it("adds an entry and keeps the user's comments", () => {
    const next = addConnectionYaml(base, { id: "b", provider: "fake", secrets: { token: "store:connection.b.token" } });
    expect(next).toContain("# my connections");
    expect(next).toContain("# keep");
    expect(next).toContain("id: b");
    expect(next).not.toContain(SECRET);
  });

  it("starts from nothing and from an empty list", () => {
    expect(addConnectionYaml("", { id: "a", provider: "fake" })).toContain("version: 1");
    const next = addConnectionYaml("version: 1\nconnections: []\n", { id: "a", provider: "fake" });
    expect(next).not.toContain("[]");
    expect(next).toContain("id: a");
  });

  it("adds a shared credential once", () => {
    const credential = { id: "photon-main", provider: "photon", secrets: { projectId: "store:credential.photon-main.projectId" } };
    let text = addConnectionYaml("", { id: "i", provider: "imessage", credential: "photon-main" }, credential);
    text = addConnectionYaml(text, { id: "w", provider: "whatsapp", credential: "photon-main" }, credential);
    expect(text.match(/id: photon-main/g)).toHaveLength(1);
  });

  it("rejects a duplicate id", () => {
    expect(() => addConnectionYaml(base, { id: "a", provider: "fake" })).toThrow("CHANNEL_OPERATION_CONFLICT");
  });

  it("updates enabled, name and secret references and can remove again", () => {
    let next = updateConnectionYaml(base, "a", { enabled: false, displayName: "Alpha", secrets: { token: "store:connection.a.token" } });
    expect(next).toContain("enabled: false");
    expect(next).toContain("displayName: Alpha");
    expect(next).toContain("store:connection.a.token");
    expect(next).not.toContain("env:A_TOKEN");
    next = updateConnectionYaml(next, "a", { enabled: true, displayName: null });
    expect(next).not.toContain("enabled");
    expect(next).not.toContain("displayName");
    expect(() => updateConnectionYaml(base, "zzz", {})).toThrow("CHANNEL_NOT_FOUND");
  });

  it("removes an entry and a credential nothing else uses", () => {
    const credential = { id: "photon-main", provider: "photon", secrets: { projectId: "store:credential.photon-main.projectId" } };
    let text = addConnectionYaml("", { id: "i", provider: "imessage", credential: "photon-main" }, credential);
    text = addConnectionYaml(text, { id: "w", provider: "whatsapp", credential: "photon-main" }, credential);
    const first = removeConnectionYaml(text, "i");
    expect(first.removedCredential).toBeUndefined();
    const second = removeConnectionYaml(first.text, "w");
    expect(second.removedCredential).toBe("photon-main");
    expect(second.text).not.toContain("photon-main");
  });
});

describe("channel service edits", () => {
  let service: ChannelService;
  let provider: ReturnType<typeof fakeChannelProvider>;
  let file: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "sf-edit-"));
    home = cwd;
    file = connectionsFilePath(cwd);
    provider = fakeChannelProvider();
    registerChannelProvider(provider);
    service = startChannelService(cwd, { intervalMs: 3600000 });
  });
  afterEach(async () => {
    await service.stop();
    await releaseChannelHost(cwd);
    unregisterChannelProvider("fake");
    await rm(file, { force: true });
    await rm(cwd, { recursive: true, force: true });
    new ChannelSecretStore(path.join(credentialRoot, "channel-secrets.json")).deleteWithPrefix("");
  });
  const input = (extra: object = {}) => ({ provider: "fake", config: { inbox: "a@b.test" }, secrets: { token: SECRET }, ...extra });

  it("creates a connection: secret in the store, only a reference in the file, check result returned", async () => {
    const result = await service.create(input({ id: "box", displayName: "Box" }));
    expect(result).toMatchObject({ id: "box", health: { state: "ok" } });
    const yaml = await readFile(file, "utf8");
    expect(yaml).toContain("store:connection.box.token");
    expect(yaml).not.toContain(SECRET);
    const stored = JSON.parse(await readFile(path.join(credentialRoot, "channel-secrets.json"), "utf8"));
    expect(stored["connection.box.token"]).toBe(SECRET);
    const listing = service.list();
    expect(listing.connections[0]).toMatchObject({ id: "box", identity: "a@b.test", secrets: { token: "store" }, health: { state: "ok" } });
    expect(JSON.stringify(listing)).not.toContain(SECRET);
  });

  it("reports a failing check but still saves", async () => {
    provider.health = "failed";
    const result = await service.create(input({ id: "box" }));
    expect(result.health).toMatchObject({ state: "failed", error: { code: "CHANNEL_AUTH_FAILED" } });
    expect(service.list().connections.map(c => c.id)).toEqual(["box"]);
  });

  it("picks a free id when none is given and refuses a duplicate", async () => {
    expect((await service.create(input())).id).toBe("fake");
    expect((await service.create(input())).id).toBe("fake-2");
    await expect(service.create(input({ id: "fake" }))).rejects.toMatchObject({ code: "CHANNEL_OPERATION_CONFLICT" });
  });

  it.each([
    [{ provider: "nope" }, "CHANNEL_PROVIDER_UNSUPPORTED"],
    [{ config: { inbox: 1 } }, "CHANNEL_INVALID_INPUT"],
    [{ secrets: {} }, "CHANNEL_INVALID_INPUT"],
    [{ secrets: { token: SECRET, bogus: "x" } }, "CHANNEL_INVALID_INPUT"],
    [{ id: "bad id" }, "CHANNEL_INVALID_INPUT"],
    [{ extra: true }, "CHANNEL_INVALID_INPUT"],
    [{ credential: "photon-main" }, "CHANNEL_INVALID_INPUT"],
  ])("rejects invalid input %j", async (extra, code) => {
    await expect(service.create(input(extra))).rejects.toMatchObject({ code });
    expect(service.list().connections).toEqual([]);
    await expect(stat(file)).rejects.toThrow();
  });

  it("does not leave a secret behind when validation fails", async () => {
    await expect(service.create(input({ config: { inbox: 1 } }))).rejects.toBeInstanceOf(ChannelError);
    const storeFile = path.join(credentialRoot, "channel-secrets.json");
    const content = await readFile(storeFile, "utf8").catch(() => "{}");
    expect(content).not.toContain(SECRET);
  });

  it("tests entered values without saving anything", async () => {
    expect(await service.test(input())).toMatchObject({ state: "ok" });
    provider.health = "failed";
    expect(await service.test(input())).toMatchObject({ state: "failed" });
    expect(service.list().connections).toEqual([]);
    await expect(stat(file)).rejects.toThrow();
  });

  it("replaces a secret, toggles enabled and removes with its secret", async () => {
    await service.create(input({ id: "box" }));
    await service.update("box", { secrets: { token: "new-secret-value" } });
    const storeFile = path.join(credentialRoot, "channel-secrets.json");
    expect(JSON.parse(await readFile(storeFile, "utf8"))["connection.box.token"]).toBe("new-secret-value");
    expect(await service.update("box", { enabled: false })).toEqual({});
    expect(service.list().connections[0]).toMatchObject({ enabled: false });
    await service.update("box", { enabled: true, displayName: "Renamed" });
    expect(service.list().connections[0]).toMatchObject({ enabled: true, displayName: "Renamed" });
    await service.remove("box");
    expect(service.list().connections).toEqual([]);
    expect(JSON.parse(await readFile(storeFile, "utf8"))).toEqual({});
    await expect(service.remove("box")).rejects.toMatchObject({ code: "CHANNEL_NOT_FOUND" });
  });

  it("restores the old secret when an update is rejected", async () => {
    await service.create(input({ id: "box" }));
    await expect(service.update("box", { config: { inbox: 5 } })).rejects.toMatchObject({ code: "CHANNEL_INVALID_INPUT" });
    await expect(service.update("box", { secrets: { bogus: "x" } })).rejects.toMatchObject({ code: "CHANNEL_INVALID_INPUT" });
    const stored = JSON.parse(await readFile(path.join(credentialRoot, "channel-secrets.json"), "utf8"));
    expect(stored["connection.box.token"]).toBe(SECRET);
  });

  it("converts an env reference to a stored secret on replace and keeps the user's comments", async () => {
    await writeFile(file, "# mine\nversion: 1\nconnections:\n  - id: box\n    provider: fake\n    config: { inbox: a@b.test }\n    secrets: { token: env:BOX_TOKEN }\n");
    await service.stop();
    await releaseChannelHost(cwd);
    service = startChannelService(cwd, { intervalMs: 3600000 });
    expect(service.list().connections[0]).toMatchObject({ secrets: { token: "env" } });
    await service.update("box", { secrets: { token: SECRET } });
    const yaml = await readFile(file, "utf8");
    expect(yaml).toContain("# mine");
    expect(yaml).toContain("store:connection.box.token");
    expect(yaml).not.toContain("BOX_TOKEN");
    expect(service.list().connections[0]).toMatchObject({ secrets: { token: "store" } });
  });

  it("honors STAGEFLOW_CONNECTIONS_FILE", () => {
    expect(connectionsFilePath("/work", { STAGEFLOW_CONNECTIONS_FILE: "/data/connections.yaml" })).toBe("/data/connections.yaml");
    expect(connectionsFilePath("/work", { STAGEFLOW_CONNECTIONS_FILE: "rel.yaml" })).toBe(path.resolve("/work", "rel.yaml"));
    expect(connectionsFilePath("/work", {})).toBe(path.join("/work", "connections.yaml"));
  });

  it("defaults to the host-level file and lets a project file take precedence", async () => {
    const project = await mkdtemp(path.join(tmpdir(), "sf-proj-"));
    try {
      const env = { STAGEFLOW_HOME: "/var/sf-home" };
      expect(connectionsFilePath(project, env)).toBe(path.join("/var/sf-home", "connections.yaml"));
      await writeFile(path.join(project, "connections.yaml"), "version: 1\n");
      expect(connectionsFilePath(project, env)).toBe(path.join(project, "connections.yaml"));
      expect(connectionsFilePath(project, { ...env, STAGEFLOW_CONNECTIONS_FILE: "/x/c.yaml" })).toBe("/x/c.yaml");
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  it("writes a first connection to the host-level file and every cached project host sees it", async () => {
    const other = await mkdtemp(path.join(tmpdir(), "sf-other-"));
    try {
      const otherHost = channelHostFor(other);
      expect(otherHost.registry.list()).toEqual([]);
      await service.create(input({ id: "shared" }));
      expect(file).toBe(path.join(process.env.STAGEFLOW_HOME!, "connections.yaml"));
      expect(otherHost.registry.list().map(entry => entry.id)).toEqual(["shared"]);
      await service.remove("shared");
      expect(otherHost.registry.list()).toEqual([]);
    } finally {
      await releaseChannelHost(other);
      await rm(other, { recursive: true, force: true });
    }
  });
});
