import { stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "../src/agents/service.js";
import { agentInput, agentsFixture, type AgentsFixture } from "./helpers/agentsHarness.js";

const fixtures: AgentsFixture[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

const yaml = (name: string) => `id: pal\nname: ${name}\ninstructions: Help.\n`;
const HOUR = 60 * 60 * 1000;

async function age(file: string, msAgo: number) {
  const when = new Date(Date.now() - msAgo);
  await utimes(file, when, when);
}

describe("agent directory sync", () => {
  it("keeps seeing outside edits after the tree has settled and been cached", async () => {
    const fixture = await agentsFixture();
    fixtures.push(fixture);
    const { service, project } = fixture;
    const file = path.join(project, "agents", "pal.agent.yaml");
    await writeFile(file, yaml("First"));
    await age(file, HOUR);
    expect((await service.list(project))[0]!.name).toBe("First");
    // settled and cached: reads keep working
    expect((await service.list(project))[0]!.name).toBe("First");
    expect((await service.get(project, "pal")).agent.name).toBe("First");

    // an outside edit with a different size, then one that only changes the mtime
    await writeFile(file, yaml("Second one"));
    await age(file, HOUR - 5_000);
    expect((await service.list(project))[0]!.name).toBe("Second one");
    await writeFile(file, yaml("Third  one"));
    await age(file, HOUR - 9_000);
    expect((await service.list(project))[0]!.name).toBe("Third  one");
  });

  it("sees a file added or removed behind its back, and our own writes", async () => {
    const fixture = await agentsFixture();
    fixtures.push(fixture);
    const { service, project } = fixture;
    const file = path.join(project, "agents", "pal.agent.yaml");
    await writeFile(file, yaml("First"));
    await age(file, HOUR);
    await service.list(project);
    await service.list(project);

    await service.create(project, agentInput("other"), { source: "console" });
    expect((await service.list(project)).map((a) => a.id).sort()).toEqual(["other", "pal"]);

    await import("node:fs/promises").then((fs) => fs.rm(file));
    expect((await service.list(project)).map((a) => a.id)).toEqual(["other"]);
    await service.archive(project, "other");
    expect(await service.list(project)).toEqual([]);
  });
});

describe("agent directory sync cache", () => {
  it("skips re-reading a tree whose stamp is unchanged, and re-reads once it changes", async () => {
    const fixture = await agentsFixture();
    fixtures.push(fixture);
    const { project, store } = fixture;
    const service = new AgentService({ store, treeTrustMs: 0 });
    const file = path.join(project, "agents", "pal.agent.yaml");
    await writeFile(file, yaml("First"));
    await age(file, HOUR);
    expect((await service.list(project))[0]!.name).toBe("First");

    // Same size and same mtime: the stamp cannot tell, so no read happens. (Real edits change mtime or size.)
    const before = await stat(file);
    await writeFile(file, yaml("Fixst"));
    await utimes(file, before.atime, before.mtime);
    expect((await service.list(project))[0]!.name).toBe("First");

    // A different mtime is a change.
    const later = new Date(before.mtimeMs + 5_000);
    await utimes(file, later, later);
    expect((await service.list(project))[0]!.name).toBe("Fixst");
  });
});
