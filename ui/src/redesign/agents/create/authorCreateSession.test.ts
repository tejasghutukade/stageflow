import { describe, expect, it } from "vitest";
import type { AgentDefinition } from "../../../api/agents";
import { newAgentDefinition } from "../model/definition";
import { createAuthorCreateClaim, mergeAuthorTurnIntoForm } from "./authorCreateSession";

function draft(patch: Partial<AgentDefinition>): AgentDefinition {
  return { ...newAgentDefinition(), ...patch };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createAuthorCreateClaim", () => {
  it("gives overlapping creates the first id and does not start a second create", async () => {
    const gate = deferred<string>();
    let creates = 0;
    const claim = createAuthorCreateClaim({
      create: async () => {
        creates += 1;
        return gate.promise;
      },
      save: async () => undefined,
    });
    const first = claim.ensure(draft({ name: "One" }));
    const second = claim.ensure(draft({ name: "Two" }));
    gate.resolve("sess-1");
    await expect(Promise.all([first, second])).resolves.toEqual(["sess-1", "sess-1"]);
    expect(creates).toBe(1);
  });

  it("clears a failed create so a later edit can try again", async () => {
    let creates = 0;
    const claim = createAuthorCreateClaim({
      create: async () => {
        creates += 1;
        if (creates === 1) throw new Error("nope");
        return "sess-2";
      },
      save: async () => undefined,
    });
    await expect(claim.ensure(draft({ name: "A" }))).rejects.toThrow("nope");
    await expect(claim.ensure(draft({ name: "A" }))).resolves.toBe("sess-2");
    expect(creates).toBe(2);
  });

  it("saves the definition current when create resolves, not the one captured at the start", async () => {
    const started = draft({ name: "Started", instructions: "a" });
    const newer = draft({ name: "Started", instructions: "b" });
    const gate = deferred<string>();
    const createdWith: AgentDefinition[] = [];
    const saved: AgentDefinition[] = [];
    const claim = createAuthorCreateClaim({
      create: async (next) => {
        createdWith.push(next);
        return gate.promise;
      },
      save: async (_id, next) => {
        saved.push(next);
      },
    });
    const pending = claim.ensure(started);
    claim.note(newer);
    gate.resolve("sess-1");
    await expect(pending).resolves.toBe("sess-1");
    expect(createdWith).toEqual([started]);
    expect(saved).toEqual([newer]);
  });

  it("does not write a superseded definition when a newer one is already current", async () => {
    const older = draft({ name: "Older" });
    const newer = draft({ name: "Newer" });
    const writes: AgentDefinition[] = [];
    const claim = createAuthorCreateClaim({
      create: async () => "sess-1",
      save: async (_id, next) => {
        writes.push(next);
      },
    });
    await claim.ensure(older);
    writes.length = 0;
    claim.note(newer);
    await claim.writeIfCurrent(older);
    await claim.writeIfCurrent(newer);
    expect(writes).toEqual([newer]);
  });
});

describe("mergeAuthorTurnIntoForm", () => {
  it("keeps the form when the turn changed nothing", () => {
    const form = draft({ name: "Old", instructions: "typed during the turn" });
    expect(mergeAuthorTurnIntoForm(form, { name: "Scout", instructions: "Search." }, [])).toBe(form);
  });

  it("applies the turn's name onto newer instructions and the next save writes that merge", async () => {
    const form = draft({ name: "Old", instructions: "typed during the turn" });
    const merged = mergeAuthorTurnIntoForm(form, { name: "Scout", id: "scout", instructions: "Search." }, [
      { label: "Identity", value: "Scout · scout" },
    ]);
    expect(merged.name).toBe("Scout");
    expect(merged.id).toBe("scout");
    expect(merged.instructions).toBe("typed during the turn");
    expect(merged.description).toBeUndefined();

    const withDescription = draft({
      name: "Old",
      description: "typed while the turn ran",
      instructions: "typed during the turn",
    });
    const sent = draft({ name: "Old", instructions: "Search." });
    const kept = mergeAuthorTurnIntoForm(
      withDescription,
      { name: "Scout", id: "scout", instructions: "Search." },
      [{ label: "Identity", value: "Scout · scout" }],
      sent,
    );
    expect(kept.name).toBe("Scout");
    expect(kept.id).toBe("scout");
    expect(kept.description).toBe("typed while the turn ran");

    const writes: AgentDefinition[] = [];
    const claim = createAuthorCreateClaim({
      create: async () => "sess-1",
      save: async (_id, next) => {
        writes.push(next);
      },
    });
    await claim.ensure(form);
    writes.length = 0;
    claim.note(merged);
    await claim.writeIfCurrent(form);
    await claim.writeIfCurrent(merged);
    expect(writes).toEqual([merged]);
  });
});
