import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ConnectionEdits, type SecretWriter } from "../src/channels/connectionEdits.js";
import { ChannelError } from "../src/channels/errors.js";

class FakeStore implements SecretWriter {
  values = new Map<string, string>();
  failSetOn?: string;
  failDeletePrefix = false;
  failOnSetNumber?: number;
  private setCalls = 0;
  get(name: string) { return this.values.get(name); }
  set(name: string, value: string) {
    if (name === this.failSetOn) throw new ChannelError("CHANNEL_STORAGE_FAILED");
    this.setCalls += 1;
    if (this.setCalls === this.failOnSetNumber) throw new ChannelError("CHANNEL_STORAGE_FAILED");
    this.values.set(name, value);
  }
  delete(name: string) { this.values.delete(name); }
  deleteWithPrefix(prefix: string) {
    if (this.failDeletePrefix) throw new ChannelError("CHANNEL_STORAGE_FAILED");
    for (const key of [...this.values.keys()]) if (key.startsWith(prefix)) this.values.delete(key);
  }
}

let dir: string;
let file: string;
let store: FakeStore;
let validated: string[];
let failValidate: boolean;
const edits = () => new ConnectionEdits({
  file: () => file,
  store,
  validate: text => { validated.push(text); if (failValidate) throw new ChannelError("CHANNEL_INVALID_INPUT"); },
});
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "sf-edits-"));
  file = path.join(dir, "connections.yaml");
  await writeFile(file, "version: 1\n");
  store = new FakeStore();
  validated = [];
  failValidate = false;
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("ConnectionEdits.apply", () => {
  it("writes the secrets and the file together", async () => {
    edits().apply({ secrets: { "connection.a.token": "t" }, rewrite: text => ({ text: `${text}# a\n` }) });
    expect(store.get("connection.a.token")).toBe("t");
    expect(await readFile(file, "utf8")).toBe("version: 1\n# a\n");
    expect(validated).toEqual(["version: 1\n# a\n"]);
  });

  it("validates before the file is touched and leaves no secret behind when validation fails", async () => {
    failValidate = true;
    expect(() => edits().apply({ secrets: { "connection.a.token": "t" }, rewrite: text => ({ text: `${text}x` }) })).toThrow("CHANNEL_INVALID_INPUT");
    expect(await readFile(file, "utf8")).toBe("version: 1\n");
    expect(store.values.size).toBe(0);
  });

  it("restores a secret that already existed instead of deleting it", async () => {
    store.values.set("connection.a.token", "old");
    failValidate = true;
    expect(() => edits().apply({ secrets: { "connection.a.token": "new" }, rewrite: text => ({ text }) })).toThrow();
    expect(store.get("connection.a.token")).toBe("old");
  });

  it("undoes the first secret when the second fails to write", async () => {
    store.values.set("b", "keep");
    store.failSetOn = "c";
    expect(() => edits().apply({ secrets: { a: "1", b: "2", c: "3" }, rewrite: text => ({ text: `${text}x` }) })).toThrow("CHANNEL_STORAGE_FAILED");
    expect([...store.values]).toEqual([["b", "keep"]]);
    expect(await readFile(file, "utf8")).toBe("version: 1\n");
    expect(validated).toEqual([]);
  });

  it("undoes the secrets when the file cannot be saved", async () => {
    await rm(dir, { recursive: true, force: true });
    await writeFile(path.join(tmpdir(), `sf-edits-block-${process.pid}`), "x");
    file = path.join(tmpdir(), `sf-edits-block-${process.pid}`, "nested", "connections.yaml");
    try {
      expect(() => edits().apply({ secrets: { a: "1" }, rewrite: () => ({ text: "version: 1\n" }) })).toThrow("CHANNEL_STORAGE_FAILED");
      expect(store.values.size).toBe(0);
    } finally {
      await rm(path.join(tmpdir(), `sf-edits-block-${process.pid}`), { force: true });
      dir = await mkdtemp(path.join(tmpdir(), "sf-edits-"));
    }
  });

  it("reports the original error even if restoring a secret also fails", () => {
    store.values.set("a", "old");
    failValidate = true;
    store.failOnSetNumber = 2;
    expect(() => edits().apply({ secrets: { a: "new" }, rewrite: text => ({ text }) })).toThrow("CHANNEL_INVALID_INPUT");
  });

  it("drops secret prefixes only after the file has committed", async () => {
    store.values.set("connection.a.token", "t");
    store.values.set("connection.b.token", "u");
    failValidate = true;
    expect(() => edits().apply({ rewrite: text => ({ text, dropSecretPrefixes: ["connection.a."] }) })).toThrow();
    expect(store.get("connection.a.token")).toBe("t");
    failValidate = false;
    edits().apply({ rewrite: text => ({ text, dropSecretPrefixes: ["connection.a."] }) });
    expect([...store.values.keys()]).toEqual(["connection.b.token"]);
  });

  it("does not fail a committed edit if cleanup of dropped secrets fails", async () => {
    store.values.set("connection.a.token", "t");
    store.failDeletePrefix = true;
    expect(() => edits().apply({ rewrite: () => ({ text: "version: 1\n# removed\n", dropSecretPrefixes: ["connection.a."] }) })).not.toThrow();
    expect(await readFile(file, "utf8")).toContain("# removed");
  });

  it("works when the file does not exist yet", async () => {
    await rm(file);
    edits().apply({ rewrite: text => ({ text: `${text || "version: 1\n"}# created\n` }) });
    expect(await readFile(file, "utf8")).toContain("# created");
  });
});
