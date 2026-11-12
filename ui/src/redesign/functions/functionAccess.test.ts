import { describe, expect, it } from "vitest";
import type { FunctionCapability } from "../../api/functions";
import {
  accessFromDefinition,
  actionOffered,
  applyAccess,
  artifactChoices,
  describeAccess,
  effectChoices,
  formatAccessSummary,
  writeOffered,
} from "./functionAccess";

const artifacts = { id: "artifacts", type: "file" as const, root: "artifacts" as const, path: "", access: "read" as const };
const env = { id: "env_1", type: "env" as const, alias: "FEED_REGION" };
const api = {
  id: "api_1",
  type: "api" as const,
  origin: "https://api.example.com",
  methods: ["GET"],
  path_prefix: "/",
  effect: "read" as const,
};
const actionApi = {
  id: "api_2",
  type: "api" as const,
  origin: "https://hooks.example.com",
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
  path_prefix: "/",
  effect: "action" as const,
  credential_ref: "vendor",
};
const reports: FunctionCapability = { id: "reports", type: "file", root: "workspace", path: "reports/", access: "read" };

describe("function access", () => {
  it("round-trips a simple definition and an empty one", () => {
    expect(accessFromDefinition([], [], "verification")).toEqual({ artifacts: "none", env: [], network: [], advanced: [] });
    expect(applyAccess({ capabilities: [], bindings: [] }, accessFromDefinition([], [], "verification"), "verification")).toEqual({
      capabilities: [],
      bindings: [],
    });
    expect(formatAccessSummary([])).toBe("No access. This function can only work on its context.");

    const capabilities = [artifacts, env, api, actionApi];
    const bindings = [{ alias: "FEED_REGION", required: false }];
    const access = accessFromDefinition(capabilities, bindings, "tool");
    expect(access).toEqual({
      artifacts: "read",
      env: [{ alias: "FEED_REGION", required: false, capabilityId: "env_1" }],
      network: [
        { capabilityId: "api_1", origin: "https://api.example.com", effect: "read" },
        { capabilityId: "api_2", origin: "https://hooks.example.com", effect: "action", credentialRef: "vendor" },
      ],
      advanced: [],
    });
    expect(applyAccess({ capabilities, bindings }, access, "tool")).toEqual({ capabilities, bindings });
  });

  it("keeps advanced capabilities untouched and in their original relative order", () => {
    const scoped: FunctionCapability = { id: "out", type: "file", root: "artifacts", path: "out.txt", access: "write" };
    const oddApi: FunctionCapability = {
      id: "api_9",
      type: "api",
      origin: "https://api.example.com",
      methods: ["POST"],
      path_prefix: "/v1",
      effect: "read",
    };
    const capabilities = [reports, env, oddApi, artifacts, scoped];
    const bindings = [{ alias: "FEED_REGION", required: true }];
    const access = accessFromDefinition(capabilities, bindings, "tool");
    expect(access.artifacts).toBe("read");
    expect(access.advanced).toEqual([reports, oddApi, scoped]);

    const renamed = applyAccess(
      { capabilities, bindings },
      { ...access, env: [{ alias: "REGION", required: true, capabilityId: "env_1" }] },
      "tool",
    );
    expect(renamed.capabilities.filter((capability) => capability.type !== "env")).toEqual([reports, oddApi, artifacts, scoped]);
    expect(renamed.capabilities.find((capability) => capability.type === "env")).toEqual({ id: "env_1", type: "env", alias: "REGION" });
    expect(renamed.bindings).toEqual([{ alias: "REGION", required: true }]);
    expect(renamed.capabilities.filter((capability) => capability.id === "reports" || capability.id === "out" || capability.id === "api_9")).toEqual([
      reports,
      oddApi,
      scoped,
    ]);
  });

  it("keeps the capability id when an alias or origin is renamed and assigns new ids from the existing scheme", () => {
    const current = { capabilities: [env, api], bindings: [{ alias: "FEED_REGION", required: true }] };
    const access = accessFromDefinition(current.capabilities, current.bindings, "tool");
    const renamed = applyAccess(
      current,
      {
        ...access,
        env: [{ alias: "FEED_LOCALE", required: false, capabilityId: "env_1" }],
        network: [{ capabilityId: "api_1", origin: "https://api.other.test", effect: "read" }],
      },
      "tool",
    );
    expect(renamed.capabilities).toEqual([
      { id: "env_1", type: "env", alias: "FEED_LOCALE" },
      { ...api, origin: "https://api.other.test" },
    ]);
    expect(renamed.bindings).toEqual([{ alias: "FEED_LOCALE", required: false }]);

    const created = applyAccess(
      { capabilities: [], bindings: [] },
      {
        artifacts: "write",
        env: [
          { alias: "A", required: true, capabilityId: "" },
          { alias: "B", required: false, capabilityId: "" },
        ],
        network: [{ capabilityId: "", origin: "https://api.example.com", effect: "action" }],
        advanced: [],
      },
      "tool",
    );
    expect(created.capabilities.map((capability) => capability.id)).toEqual(["artifacts", "env_2", "env_3", "api_4"]);
    expect(created.capabilities[0]).toMatchObject({ root: "artifacts", path: "", access: "write" });
    expect(created.capabilities[3]).toMatchObject({ id: "api_4", methods: ["GET", "POST", "PUT", "PATCH", "DELETE"], effect: "action", path_prefix: "/" });
    const onlyEnv = applyAccess(
      { capabilities: [], bindings: [] },
      { artifacts: "none", env: [{ alias: "A", required: true, capabilityId: "" }], network: [], advanced: [] },
      "tool",
    );
    expect(onlyEnv.capabilities[0]).toMatchObject({ id: "env_1", type: "env" });
    expect(created.bindings).toEqual([
      { alias: "A", required: true },
      { alias: "B", required: false },
    ]);
  });

  it("offers write and action only for a tool, or when that access is already present", () => {
    expect(writeOffered("verification", "none")).toBe(false);
    expect(writeOffered("verification", "write")).toBe(true);
    expect(writeOffered("tool", "read")).toBe(true);
    expect(artifactChoices("verification", "none")).toEqual(["None", "Read"]);
    expect(artifactChoices("verification", "write")).toEqual(["None", "Read", "Read and write"]);
    expect(artifactChoices("tool", "none")).toEqual(["None", "Read", "Read and write"]);
    expect(actionOffered("routing", "read")).toBe(false);
    expect(actionOffered("routing", "action")).toBe(true);
    expect(effectChoices("verification", "read").map((choice) => choice.label)).toEqual(["Read"]);
    expect(effectChoices("tool", "read").map((choice) => choice.label)).toEqual(["Read", "Action"]);

    const present = [ { ...artifacts, access: "write" as const }, actionApi ];
    const access = accessFromDefinition(present, [], "verification");
    expect(access.artifacts).toBe("write");
    expect(access.network[0]?.effect).toBe("action");
    expect(applyAccess({ capabilities: present, bindings: [] }, access, "verification")).toEqual({ capabilities: present, bindings: [] });

    const blocked = applyAccess(
      { capabilities: [], bindings: [] },
      {
        artifacts: "write",
        env: [],
        network: [{ capabilityId: "", origin: "https://api.example.com", effect: "action" }],
        advanced: [],
      },
      "verification",
    );
    expect(blocked.capabilities).toEqual([
      { id: "artifacts", type: "file", root: "artifacts", path: "", access: "read" },
      { id: "api_2", type: "api", origin: "https://api.example.com", methods: ["GET"], path_prefix: "/", effect: "read" },
    ]);
  });

  it("describes every capability in order", () => {
    expect(
      describeAccess([
        artifacts,
        { id: "w", type: "file", root: "workspace", path: "reports/", access: "read" },
        { id: "artifacts", type: "file", root: "artifacts", path: "", access: "write" },
        env,
        api,
      ]),
    ).toEqual(["Read artifacts", "Read workspace reports/", "Write artifacts", "Env FEED_REGION", "API https://api.example.com (read)"]);
    expect(formatAccessSummary([artifacts, env])).toBe("Read artifacts · Env FEED_REGION");
  });

  it("treats a missing env binding as required and drops bindings with no env capability", () => {
    const access = accessFromDefinition([env], [], "routing");
    expect(access.env).toEqual([{ alias: "FEED_REGION", required: true, capabilityId: "env_1" }]);
    const applied = applyAccess({ capabilities: [env], bindings: [{ alias: "OTHER", required: true }] }, access, "routing");
    expect(applied.bindings).toEqual([{ alias: "FEED_REGION", required: true }]);
  });

  it("sends every file capability to advanced when more than one grants the whole artifacts root", () => {
    const second = { ...artifacts, id: "file_2" };
    const access = accessFromDefinition([artifacts, second], [], "tool");
    expect(access.artifacts).toBe("none");
    expect(access.advanced).toEqual([artifacts, second]);
    expect(applyAccess({ capabilities: [artifacts, second], bindings: [] }, access, "tool").capabilities).toEqual([artifacts, second]);
  });
});
