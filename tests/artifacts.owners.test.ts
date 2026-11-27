import { describe, expect, it } from "vitest";
import {
  ARTIFACT_OWNERS,
  artifactOwnerKey,
  ownerColumns,
  ownerFromRow,
  ownerMatchSql,
  ownerSearchText,
  ownerSearchTextSql,
  ownerSubstringSql,
  parseOwnerKey,
  type ArtifactOwner,
  type ArtifactOwnerKind,
} from "../src/artifacts/owners.js";

const SAMPLES: { [K in ArtifactOwnerKind]: Extract<ArtifactOwner, { kind: K }> } = {
  stage: { kind: "stage", pipeline: "sales", stage: "summarize" },
  agent: { kind: "agent", agent: "helper" },
  guide: { kind: "guide" },
};

describe("artifact owner registry", () => {
  it("has a descriptor for every owner kind, keyed by its kind", () => {
    for (const kind of Object.keys(SAMPLES) as ArtifactOwnerKind[]) {
      expect(ARTIFACT_OWNERS[kind]?.kind).toBe(kind);
    }
    expect(Object.keys(ARTIFACT_OWNERS).sort()).toEqual(Object.keys(SAMPLES).sort());
  });

  it("round-trips every owner through its key and its row", () => {
    for (const owner of Object.values(SAMPLES)) {
      expect(parseOwnerKey(artifactOwnerKey(owner))).toEqual(owner);
      expect(ownerFromRow(ownerColumns(owner))).toEqual(owner);
    }
  });

  it("keeps the stored key formats and columns", () => {
    expect(artifactOwnerKey(SAMPLES.stage)).toBe("stage:sales:summarize");
    expect(artifactOwnerKey(SAMPLES.agent)).toBe("agent:helper");
    expect(artifactOwnerKey(SAMPLES.guide)).toBe("guide");
    expect(ownerColumns(SAMPLES.agent)).toEqual({ owner_kind: "agent", owner_pipeline: null, owner_stage: null, owner_agent: "helper" });
    expect(ownerColumns(SAMPLES.guide)).toEqual({ owner_kind: "guide", owner_pipeline: null, owner_stage: null, owner_agent: null });
    expect(ownerFromRow({ owner_kind: "unknown", owner_pipeline: "p", owner_stage: "s", owner_agent: null })).toEqual({
      kind: "stage",
      pipeline: "p",
      stage: "s",
    });
  });

  it("rejects keys no descriptor accepts", () => {
    for (const key of ["guide:x", "stage:a", "stage::b", "stage:a:", "agent:", "agent:a/b", "agent:a::b", "other:x"]) {
      expect(parseOwnerKey(key)).toBeUndefined();
    }
  });

  it("builds the same search text and SQL the queries used before the registry", () => {
    expect(ownerSearchText(ownerColumns(SAMPLES.stage))).toBe("stage:sales:summarize sales summarize");
    expect(ownerSearchText(ownerColumns(SAMPLES.agent))).toBe("agent:helper helper");
    expect(ownerSearchText(ownerColumns(SAMPLES.guide))).toBe("guide");
    expect(ownerMatchSql(SAMPLES.stage, { alias: "a", paramPrefix: "owner_" })).toEqual({
      sql: "a.owner_kind = 'stage' AND a.owner_pipeline = @owner_pipeline AND a.owner_stage = @owner_stage",
      params: { owner_pipeline: "sales", owner_stage: "summarize" },
    });
    expect(ownerMatchSql(SAMPLES.guide)).toEqual({ sql: "owner_kind = 'guide'", params: {} });
    expect(ownerSubstringSql("a", "owner_sub")).toBe(
      "instr(lower(trim(coalesce(a.owner_pipeline, '') || ' ' || coalesce(a.owner_stage, '') || ' ' || coalesce(a.owner_agent, '') || CASE WHEN a.owner_kind = 'guide' THEN ' guide' ELSE '' END)), @owner_sub) > 0",
    );
    expect(ownerSearchTextSql("a")).toBe(
      "CASE a.owner_kind WHEN 'agent' THEN 'agent:' || COALESCE(a.owner_agent, '') || ' ' || COALESCE(a.owner_agent, '') WHEN 'guide' THEN 'guide' ELSE 'stage:' || COALESCE(a.owner_pipeline, '') || ':' || COALESCE(a.owner_stage, '') || ' ' || COALESCE(a.owner_pipeline, '') || ' ' || COALESCE(a.owner_stage, '') END",
    );
  });
});
