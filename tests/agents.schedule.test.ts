import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentScheduleSource } from "../src/agents/scheduleSource.js";
import { agentInput, agentsFixture, type AgentsFixture } from "./helpers/agentsHarness.js";

const fixtures: AgentsFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

describe("agent schedule source", () => {
  it("seeds the next run, fires once when due (even after missed runs), then moves on", async () => {
    const fixture = await agentsFixture();
    fixtures.push(fixture);
    const { service, project, clock } = fixture;
    await service.create(
      project,
      agentInput("digest", { schedule: { cron: "0 9 * * *", timezone: "UTC", message: "Post the digest" } }),
      { source: "console" },
    );
    await service.setEnabled(project, "digest", true, { source: "console" });
    const source = new AgentScheduleSource({ service, projectRoot: project, intervalMs: 0, now: () => clock.now });
    const onFire = vi.fn(async () => undefined);

    await source.tick(onFire);
    expect(onFire).not.toHaveBeenCalled();
    expect(service.scheduleNextRun(project, "digest")).toBe("2026-10-16T09:00:00.000Z");

    clock.advance(3 * 24 * 60 * 60 * 1000);
    await source.tick(onFire);
    expect(onFire).toHaveBeenCalledOnce();
    expect(onFire).toHaveBeenCalledWith({ agentId: "digest", message: "Post the digest" });
    expect(service.scheduleNextRun(project, "digest")).toBe("2026-10-19T09:00:00.000Z");

    await source.tick(onFire);
    expect(onFire).toHaveBeenCalledOnce();
  });

  it("ignores disabled agents", async () => {
    const fixture = await agentsFixture();
    fixtures.push(fixture);
    const { service, project, clock } = fixture;
    await service.create(project, agentInput("digest", { schedule: { cron: "* * * * *" } }), { source: "console" });
    const source = new AgentScheduleSource({ service, projectRoot: project, intervalMs: 0, now: () => clock.now });
    await source.tick(vi.fn());
    expect(service.scheduleNextRun(project, "digest")).toBeUndefined();
  });
});
