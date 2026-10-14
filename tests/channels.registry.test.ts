import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { inspect } from "node:util";
import { ChannelRegistry } from "../src/channels/registry.js";
import { ChannelError } from "../src/channels/errors.js";
import { fakeChannelProvider } from "./fixtures/fakeChannelProvider.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function registry(yaml: string | undefined, options: { env?: NodeJS.ProcessEnv; providers?: ReturnType<typeof fakeChannelProvider>[] } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "sf-channels-"));
  roots.push(root);
  if (yaml !== undefined) await writeFile(path.join(root, "connections.yaml"), yaml);
  return { root, registry: new ChannelRegistry({ cwd: root, env: options.env ?? {}, providers: options.providers ?? [fakeChannelProvider()] }) };
}
function code(fn: () => unknown): { code?: string; detail?: unknown } {
  try { fn(); } catch (error) {
    if (error instanceof ChannelError) return { code: error.code, detail: error.detail };
    return { code: "other" };
  }
  return {};
}

const base = (extra = "") => `version: 1\nconnections:\n  - id: box\n    provider: fake\n    config: { inbox: a@b.test }\n    secrets: { token: env:BOX_TOKEN }\n${extra}`;

describe("ChannelRegistry loading", () => {
  it("is empty without a file", async () => {
    const { registry: r } = await registry(undefined);
    expect(r.list()).toEqual([]);
  });

  it("lists masked summaries with provider identity", async () => {
    const { registry: r, root } = await registry(base("    displayName: Box\n"));
    expect(r.list()).toEqual([{ id: "box", scope: path.resolve(root), provider: "fake", displayName: "Box", enabled: true, identity: "a@b.test" }]);
    expect(JSON.stringify(r.list())).not.toContain("BOX_TOKEN");
  });

  it("defaults the display name to the id and takes an explicit scope", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-channels-"));
    roots.push(root);
    await writeFile(path.join(root, "connections.yaml"), base());
    const r = new ChannelRegistry({ cwd: root, scope: "tenant-1", env: {}, providers: [fakeChannelProvider()] });
    expect(r.list()[0]).toMatchObject({ displayName: "box", scope: "tenant-1" });
  });

  it("rejects providers that are not registered", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-channels-"));
    roots.push(root);
    await writeFile(path.join(root, "connections.yaml"), base());
    expect(code(() => new ChannelRegistry({ cwd: root, providers: [] })).code).toBe("CHANNEL_PROVIDER_UNSUPPORTED");
  });

  it("rejects provider config the provider refuses", async () => {
    const yaml = "version: 1\nconnections:\n  - id: box\n    provider: fake\n    config: { inbox: a, extra: 1 }\n    secrets: { token: env:T }\n";
    const root = await mkdtemp(path.join(tmpdir(), "sf-channels-"));
    roots.push(root);
    await writeFile(path.join(root, "connections.yaml"), yaml);
    expect(code(() => new ChannelRegistry({ cwd: root, providers: [fakeChannelProvider()] }))).toEqual({ code: "CHANNEL_INVALID_INPUT", detail: { connectionId: "box", field: "config" } });
  });

  it.each([
    ["unknown secret name", "    secrets: { token: env:T, nope: env:N }\n", "nope"],
    ["missing required secret", "", "token"],
  ])("rejects %s", async (_n, secrets, field) => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-channels-"));
    roots.push(root);
    await writeFile(path.join(root, "connections.yaml"), `version: 1\nconnections:\n  - id: box\n    provider: fake\n    config: { inbox: a }\n${secrets}`);
    expect(code(() => new ChannelRegistry({ cwd: root, providers: [fakeChannelProvider()] }))).toEqual({ code: "CHANNEL_INVALID_INPUT", detail: { connectionId: "box", field } });
  });
});

describe("credentials", () => {
  const withCredential = (provider: string, credential: string) =>
    `version: 1\ncredentials:\n  - id: photon-main\n    provider: ${provider}\n    secrets: { projectId: env:PID }\nconnections:\n  - id: box\n    provider: fake\n    config: { inbox: a }\n    credential: ${credential}\n    secrets: { token: env:T }\n`;

  it("resolves a referenced credential of the right kind", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-channels-"));
    roots.push(root);
    await writeFile(path.join(root, "connections.yaml"), withCredential("photon", "photon-main"));
    const r = new ChannelRegistry({ cwd: root, env: { T: "tok", PID: "proj" }, providers: [fakeChannelProvider({ credentialProvider: "photon" })] });
    expect(r.resolve("box").credential?.secrets).toEqual({ projectId: "proj" });
    expect(r.list()[0]?.credential).toBe("photon-main");
  });

  it.each([
    ["wrong credential provider", withCredential("other", "photon-main")],
    ["missing credential", withCredential("photon", "ghost")],
  ])("rejects %s", async (_n, yaml) => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-channels-"));
    roots.push(root);
    await writeFile(path.join(root, "connections.yaml"), yaml);
    expect(code(() => new ChannelRegistry({ cwd: root, providers: [fakeChannelProvider({ credentialProvider: "photon" })] })).code).toBe("CHANNEL_INVALID_INPUT");
  });

  it("rejects a credential on a provider that takes none", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-channels-"));
    roots.push(root);
    await writeFile(path.join(root, "connections.yaml"), withCredential("photon", "photon-main"));
    expect(code(() => new ChannelRegistry({ cwd: root, providers: [fakeChannelProvider()] })).code).toBe("CHANNEL_INVALID_INPUT");
  });

  it("requires a credential when the provider needs one", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-channels-"));
    roots.push(root);
    await writeFile(path.join(root, "connections.yaml"), base());
    expect(code(() => new ChannelRegistry({ cwd: root, providers: [fakeChannelProvider({ credentialProvider: "photon" })] })).code).toBe("CHANNEL_INVALID_INPUT");
  });
});

describe("lookup and resolution", () => {
  it("reports unknown and disabled connections", async () => {
    const { registry: r } = await registry(base("  - id: off\n    provider: fake\n    enabled: false\n    config: { inbox: z }\n    secrets: { token: env:T }\n"));
    expect(code(() => r.get("ghost"))).toEqual({ code: "CHANNEL_NOT_FOUND", detail: { connectionId: "ghost" } });
    expect(code(() => r.get("off"))).toEqual({ code: "CHANNEL_DISABLED", detail: { connectionId: "off" } });
    expect(r.get("off", false).enabled).toBe(false);
  });

  it("resolves secrets from the environment at call time and from NAME_FILE", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-channels-"));
    roots.push(root);
    await writeFile(path.join(root, "connections.yaml"), base());
    const file = path.join(root, "token.txt");
    await writeFile(file, "from-file\n");
    const env: NodeJS.ProcessEnv = {};
    const r = new ChannelRegistry({ cwd: root, env, providers: [fakeChannelProvider()] });
    env.BOX_TOKEN = "first";
    expect(r.resolve("box").secrets.token).toBe("first");
    delete env.BOX_TOKEN;
    env.BOX_TOKEN_FILE = file;
    expect(r.resolve("box").secrets.token).toBe("from-file");
  });

  it("fails with a secret-free error when the variable is missing, empty, or ambiguous", async () => {
    const { registry: r } = await registry(base(), { env: { BOX_TOKEN: "" } });
    expect(code(() => r.resolve("box"))).toEqual({ code: "CHANNEL_SECRET_UNAVAILABLE", detail: { connectionId: "box", field: "token" } });
    const root = await mkdtemp(path.join(tmpdir(), "sf-channels-"));
    roots.push(root);
    await writeFile(path.join(root, "connections.yaml"), base());
    const both = new ChannelRegistry({ cwd: root, env: { BOX_TOKEN: "plain-secret-value", BOX_TOKEN_FILE: "/nope" }, providers: [fakeChannelProvider()] });
    const out = code(() => both.resolve("box"));
    expect(out.code).toBe("CHANNEL_SECRET_UNAVAILABLE");
    try { both.resolve("box"); } catch (error) { expect(JSON.stringify(error) + String(error)).not.toContain("plain-secret-value"); }
  });

  it("keeps secret values out of JSON and inspect output", async () => {
    const { registry: r } = await registry(base(), { env: { BOX_TOKEN: "super-secret-token" } });
    const resolved = r.resolve("box");
    expect(resolved.secrets.token).toBe("super-secret-token");
    expect(JSON.stringify(resolved)).not.toContain("super-secret-token");
    expect(inspect(resolved, { depth: 5, showHidden: true })).not.toContain("super-secret-token");
    expect(Object.keys(resolved)).not.toContain("secrets");
    expect(`${JSON.stringify(resolved)}`).toContain('"id":"box"');
  });

  it("returns a copy of config", async () => {
    const { registry: r } = await registry(base(), { env: { BOX_TOKEN: "t" } });
    (r.resolve("box").config as { inbox: string }).inbox = "changed";
    expect((r.resolve("box").config as { inbox: string }).inbox).toBe("a@b.test");
  });

  it("validates targets through the provider", async () => {
    const { registry: r } = await registry(base());
    expect(r.validateTarget("box", { to: "#general" })).toBe("#general");
    expect(code(() => r.validateTarget("box", { to: "" }))).toEqual({ code: "CHANNEL_TARGET_INVALID", detail: { connectionId: "box" } });
    expect(r.providerFor("box").id).toBe("fake");
  });
});
