import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CONNECTIONS_FILE_LIMIT_BYTES, loadConnectionsFile, parseConnectionsYaml } from "../src/channels/config.js";
import { ChannelError } from "../src/channels/errors.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function tmp(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "sf-channels-"));
  roots.push(root);
  return root;
}
function code(fn: () => unknown): string | undefined {
  try { fn(); } catch (error) { return error instanceof ChannelError ? error.code : "other"; }
  return undefined;
}

const valid = `
version: 1
credentials:
  - id: photon-main
    provider: photon
    secrets:
      projectId: env:PHOTON_PROJECT_ID
connections:
  - id: support-inbox
    provider: agentmail
    displayName: Support inbox
    config: { inbox: support@agentmail.to }
    secrets: { apiKey: env:AGENTMAIL_API_KEY }
  - id: wa
    provider: whatsapp
    credential: photon-main
    enabled: false
`;

describe("connections.yaml parsing", () => {
  it("parses credentials and connections with defaults", () => {
    const file = parseConnectionsYaml(valid);
    expect(file.credentials).toHaveLength(1);
    expect(file.connections.map(c => c.id)).toEqual(["support-inbox", "wa"]);
    expect(file.connections[1]).toMatchObject({ enabled: false, credential: "photon-main", config: {}, secrets: {} });
    expect(file.connections[0]?.enabled).toBe(true);
  });

  it("treats an empty connections list as valid", () => {
    expect(parseConnectionsYaml("version: 1\n")).toEqual({ credentials: [], connections: [] });
  });

  it.each([
    ["inline secret value", "version: 1\nconnections:\n  - id: a\n    provider: slack\n    secrets: { botToken: xoxb-literal }\n"],
    ["secret ref without env prefix", "version: 1\nconnections:\n  - id: a\n    provider: slack\n    secrets: { botToken: SLACK_TOKEN }\n"],
    ["file: secret reference", "version: 1\nconnections:\n  - id: a\n    provider: slack\n    secrets: { botToken: file:/etc/token }\n"],
    ["unknown top-level key", "version: 1\nextra: true\n"],
    ["unknown connection key", "version: 1\nconnections:\n  - id: a\n    provider: slack\n    token: x\n"],
    ["wrong version", "version: 2\n"],
    ["missing version", "connections: []\n"],
    ["bad id", "version: 1\nconnections:\n  - id: -bad\n    provider: slack\n"],
    ["bad provider", "version: 1\nconnections:\n  - id: a\n    provider: Slack!\n"],
    ["duplicate connection ids", "version: 1\nconnections:\n  - { id: a, provider: slack }\n  - { id: a, provider: slack }\n"],
    ["duplicate credential ids", "version: 1\ncredentials:\n  - { id: a, provider: photon }\n  - { id: a, provider: photon }\n"],
    ["duplicate yaml keys", "version: 1\nversion: 1\n"],
    ["yaml alias", "version: 1\nconnections:\n  - &a { id: a, provider: slack }\n  - *a\n"],
    ["not yaml", "version: [1"],
  ])("rejects %s", (_name, text) => {
    expect(code(() => parseConnectionsYaml(text))).toBe("CHANNEL_INVALID_INPUT");
  });

  it("allows the same id in credentials and connections", () => {
    expect(() => parseConnectionsYaml("version: 1\ncredentials:\n  - { id: a, provider: photon }\nconnections:\n  - { id: a, provider: slack }\n")).not.toThrow();
  });

  it("rejects more than 100 connections", () => {
    const rows = Array.from({ length: 101 }, (_, i) => `  - { id: c${i}, provider: slack }`).join("\n");
    expect(code(() => parseConnectionsYaml(`version: 1\nconnections:\n${rows}\n`))).toBe("CHANNEL_INVALID_INPUT");
  });
});

describe("loadConnectionsFile", () => {
  it("treats a missing file as empty", async () => {
    const root = await tmp();
    expect(loadConnectionsFile(path.join(root, "connections.yaml"))).toEqual({ credentials: [], connections: [] });
  });

  it("loads a file from disk", async () => {
    const root = await tmp();
    const file = path.join(root, "connections.yaml");
    await writeFile(file, valid);
    expect(loadConnectionsFile(file).connections).toHaveLength(2);
  });

  it("rejects files over the size limit", async () => {
    const root = await tmp();
    const file = path.join(root, "connections.yaml");
    await writeFile(file, `version: 1\n# ${"x".repeat(CONNECTIONS_FILE_LIMIT_BYTES)}\n`);
    expect(code(() => loadConnectionsFile(file))).toBe("CHANNEL_RESOURCE_LIMIT");
  });

  it("rejects a directory in place of the file", async () => {
    const root = await tmp();
    const file = path.join(root, "connections.yaml");
    await mkdir(file);
    expect(code(() => loadConnectionsFile(file))).toBe("CHANNEL_INVALID_INPUT");
  });

  it("does not echo file content in errors", async () => {
    const root = await tmp();
    const file = path.join(root, "connections.yaml");
    await writeFile(file, "version: 1\nconnections:\n  - id: a\n    provider: slack\n    secrets: { botToken: xoxb-super-secret-literal }\n");
    try { loadConnectionsFile(file); } catch (error) {
      expect(JSON.stringify(error)).not.toContain("super-secret");
      expect(String((error as Error).message)).not.toContain("super-secret");
      expect(String((error as Error).stack)).not.toContain("super-secret");
    }
  });
});
