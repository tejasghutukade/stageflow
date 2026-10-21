import { createHash } from "node:crypto";
import { PACKAGE_VERSION, BUILD_SHA } from "../package-meta.js";
import type { CallerSurface } from "../server/requestAuthContext.js";
import type { ToolchainCheck } from "../preflight/toolchain.js";
import type { SkillOrigin } from "../config/listSkills.js";
import type { ResolvedMcpServers } from "../config/resolveStageMcpServers.js";
import type { SkillsPayload } from "../runtime/runSkills.js";
import type { LoadedStageConfig } from "../types/stage.js";
import {
  redact,
  type NamedSecret,
  type RedactOptions,
} from "../logging/redact.js";
import { getNamedSecrets } from "../logging/namedSecrets.js";
import { CURRENT_SCHEMA_VERSION } from "./sqlite/migrations/index.js";
import type { RunStore } from "./port.js";

export const RUN_MANIFEST_VERSION = 1 as const;

export type ModelAuthoredTier = "stage" | "pipeline" | "global";

export type RunManifestHost = {
  stageflow_version: string;
  build_sha: string;
  image_digest: string | null;
  schema_version: number;
};

export type RunManifestCaller = {
  caller_id: string | null;
  surface: CallerSurface;
};

export type RunManifestBinding =
  | {
      kind: "repository";
      repository: string;
      ref?: string;
      resolved_sha?: string;
      branch?: string;
      worktree_path?: string;
    }
  | {
      kind: "checkout";
      resolved_sha?: string;
      worktree_path?: string;
    }
  | { kind: "unbound" };

export type RunManifestPipeline = {
  source: "inline" | "path";
  path: string | null;
  bytes_sha256: string;
  body: unknown;
};

export type RunManifestTask = {
  source: "inline" | "path";
  path: string | null;
  bytes_sha256: string;
  body: string;
};

export type RunManifestSkill = {
  name: string;
  origin: SkillOrigin;
  digest: string;
  files: string[];
};

export type RunManifestStageModel = {
  authored: string;
  authored_tier: ModelAuthoredTier;
  resolved?: string;
  thinking_level?: string;
};

export type RunManifestMcpServer = {
  name: string;
  command?: string;
  args?: unknown;
  env?: Record<string, unknown>;
  url?: string;
  origin?: string;
  [key: string]: unknown;
};

export type RunManifestStage = {
  stage_id: string;
  model: RunManifestStageModel;
  mcp_servers: RunManifestMcpServer[];
};

export type RunManifestToolchainEntry = {
  tool: string;
  required?: string;
  resolved?: string;
  path?: string;
  origin?: ToolchainCheck["origin"];
  status?: ToolchainCheck["status"];
};

export type RunManifestV1 = {
  manifest_version: typeof RUN_MANIFEST_VERSION;
  run_id: string;
  created_at: string;
  finalised_at?: string;
  host: RunManifestHost;
  caller: RunManifestCaller;
  binding: RunManifestBinding;
  pipeline: RunManifestPipeline;
  task: RunManifestTask;
  skills: RunManifestSkill[];
  stages: RunManifestStage[];
  toolchain: RunManifestToolchainEntry[];
};

export type RunManifest = RunManifestV1;

export function sha256Hex(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function sha256Digest(bytes: string | Buffer): string {
  return `sha256:${sha256Hex(bytes)}`;
}

export function digestSkillFiles(
  files: Record<string, string>,
): { digest: string; files: string[] } {
  const names = Object.keys(files).sort();
  const hash = createHash("sha256");
  for (const name of names) {
    hash.update(name);
    hash.update("\0");
    hash.update(files[name] ?? "");
    hash.update("\0");
  }
  return { digest: `sha256:${hash.digest("hex")}`, files: names };
}

export function skillsFromPayload(
  payload: SkillsPayload | undefined,
): RunManifestSkill[] {
  if (payload === undefined) return [];
  const out: RunManifestSkill[] = [];
  for (const [name, files] of Object.entries(payload)) {
    const dig = digestSkillFiles(files);
    out.push({
      name,
      origin: "run",
      digest: dig.digest,
      files: dig.files,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function toolchainFromChecks(
  checks: readonly ToolchainCheck[],
): RunManifestToolchainEntry[] {
  return checks.map((c) => ({
    tool: c.tool,
    ...(c.required !== undefined ? { required: c.required } : {}),
    ...(c.found !== undefined ? { resolved: c.found } : {}),
    ...(c.path !== undefined ? { path: c.path } : {}),
    origin: c.origin,
    status: c.status,
  }));
}

export function bindingFromFields(fields: {
  repository?: string;
  ref?: string;
  resolvedSha?: string;
  runBranch?: string;
  checkoutRoot?: string;
}): RunManifestBinding {
  if (fields.repository != null && fields.repository !== "") {
    return {
      kind: "repository",
      repository: fields.repository,
      ...(fields.ref !== undefined ? { ref: fields.ref } : {}),
      ...(fields.resolvedSha !== undefined
        ? { resolved_sha: fields.resolvedSha }
        : {}),
      ...(fields.runBranch !== undefined ? { branch: fields.runBranch } : {}),
      ...(fields.checkoutRoot !== undefined
        ? { worktree_path: fields.checkoutRoot }
        : {}),
    };
  }
  if (fields.checkoutRoot != null && fields.checkoutRoot !== "") {
    return {
      kind: "checkout",
      ...(fields.resolvedSha !== undefined
        ? { resolved_sha: fields.resolvedSha }
        : {}),
      worktree_path: fields.checkoutRoot,
    };
  }
  return { kind: "unbound" };
}

export function stagesFromLoaded(
  stages: readonly LoadedStageConfig[],
): RunManifestStage[] {
  return stages.map((stage) => ({
    stage_id: stage.id,
    model: {
      authored: stage.model,
      authored_tier: stage.model_tier ?? "stage",
    },
    mcp_servers: [],
  }));
}

export function buildHostIdentity(
  env: NodeJS.ProcessEnv = process.env,
): RunManifestHost {
  const digest = env.STAGEFLOW_IMAGE_DIGEST?.trim();
  return {
    stageflow_version: PACKAGE_VERSION,
    build_sha: BUILD_SHA,
    image_digest: digest && digest.length > 0 ? digest : null,
    schema_version: CURRENT_SCHEMA_VERSION,
  };
}

export type BuildInitialRunManifestInput = {
  runId: string;
  createdAt: string;
  callerId: string | null;
  surface: CallerSurface;
  binding: RunManifestBinding;
  pipelineSource: "inline" | "path";
  pipelinePath?: string;
  pipelineBody?: string | null;
  taskYaml: string;
  taskPath?: string;
  skills?: SkillsPayload;
  stages: readonly LoadedStageConfig[];
  toolchain: readonly ToolchainCheck[];
  namedSecrets?: readonly NamedSecret[];
};

export function buildInitialRunManifest(
  input: BuildInitialRunManifestInput,
): RunManifestV1 {
  const pipelineBody =
    input.pipelineSource === "inline" && input.pipelineBody
      ? (() => {
          try {
            return JSON.parse(input.pipelineBody) as unknown;
          } catch {
            return input.pipelineBody;
          }
        })()
      : null;
  const pipelineBytes =
    input.pipelineSource === "inline" && input.pipelineBody
      ? input.pipelineBody
      : input.pipelinePath ?? "";
  const taskSource: "inline" | "path" =
    input.taskPath !== undefined && input.taskPath.length > 0
      ? "path"
      : "inline";

  const raw: RunManifestV1 = {
    manifest_version: RUN_MANIFEST_VERSION,
    run_id: input.runId,
    created_at: input.createdAt,
    host: buildHostIdentity(),
    caller: {
      caller_id: input.callerId,
      surface: input.surface,
    },
    binding: input.binding,
    pipeline: {
      source: input.pipelineSource,
      path: input.pipelinePath ?? null,
      bytes_sha256: sha256Hex(pipelineBytes),
      body: pipelineBody,
    },
    task: {
      source: taskSource,
      path: input.taskPath ?? null,
      bytes_sha256: sha256Hex(input.taskYaml),
      body: input.taskYaml,
    },
    skills: skillsFromPayload(input.skills),
    stages: stagesFromLoaded(input.stages),
    toolchain: toolchainFromChecks(input.toolchain),
  };
  return redactRunManifest(raw, {
    namedSecrets: input.namedSecrets ?? getNamedSecrets(),
  });
}

export function parseRunManifest(value: unknown): RunManifest | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) return null;
  const version = (value as { manifest_version?: unknown }).manifest_version;
  if (version === 1) {
    return value as RunManifestV1;
  }
  return null;
}

export function collectMcpEnvNamedSecrets(
  servers: ResolvedMcpServers | undefined,
): NamedSecret[] {
  if (servers === undefined) return [];
  const out: NamedSecret[] = [];
  for (const [serverName, cfg] of Object.entries(servers)) {
    const env = cfg.env;
    if (env === null || typeof env !== "object" || Array.isArray(env)) continue;
    for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
      if (typeof value === "string" && value.length > 0) {
        out.push({ name: `${serverName}.${key}`, value });
      }
    }
  }
  return out;
}

export function collectDeclaredSecretValues(
  names: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): NamedSecret[] {
  const out: NamedSecret[] = [];
  for (const name of names) {
    const plain = env[name];
    if (typeof plain === "string" && plain.length > 0) {
      out.push({ name, value: plain });
    }
  }
  return out;
}

export function redactMcpServers(
  servers: ResolvedMcpServers,
  namedSecrets: readonly NamedSecret[],
  origins?: ReadonlyMap<string, string>,
): RunManifestMcpServer[] {
  const out: RunManifestMcpServer[] = [];
  for (const [name, cfg] of Object.entries(servers)) {
    const redacted = redact(
      { ...cfg } as Record<string, unknown>,
      { namedSecrets },
    );
    out.push({
      name,
      ...redacted,
      ...(origins?.get(name) !== undefined
        ? { origin: origins.get(name) }
        : {}),
    });
  }
  return out;
}

export function redactRunManifest(
  manifest: RunManifestV1,
  options: RedactOptions = {},
): RunManifestV1 {
  const namedSecrets = [
    ...(options.namedSecrets ?? getNamedSecrets()),
  ];
  return redact({ ...manifest } as Record<string, unknown>, {
    ...options,
    namedSecrets,
  }) as RunManifestV1;
}

/** Defense-in-depth redaction for get_run / export views (pipeline body included). */
export function redactRunManifestForRead(
  value: unknown,
  options: RedactOptions = {},
): RunManifest | null {
  const parsed = parseRunManifest(value);
  if (parsed === null) return null;
  if (parsed.manifest_version === 1) {
    return redactRunManifest(parsed, options);
  }
  return null;
}

export function withStageResolvedModel(
  manifest: RunManifestV1,
  stageId: string,
  resolved: { model: string; thinkingLevel?: string },
): RunManifestV1 {
  const stages = manifest.stages.map((stage) => {
    if (stage.stage_id !== stageId) return stage;
    return {
      ...stage,
      model: {
        ...stage.model,
        resolved: resolved.model,
        ...(resolved.thinkingLevel !== undefined
          ? { thinking_level: resolved.thinkingLevel }
          : {}),
      },
    };
  });
  const has = stages.some((s) => s.stage_id === stageId);
  if (!has) {
    stages.push({
      stage_id: stageId,
      model: {
        authored: resolved.model,
        authored_tier: "stage",
        resolved: resolved.model,
        ...(resolved.thinkingLevel !== undefined
          ? { thinking_level: resolved.thinkingLevel }
          : {}),
      },
      mcp_servers: [],
    });
  }
  return { ...manifest, stages };
}

export function withStageMcpServers(
  manifest: RunManifestV1,
  stageId: string,
  mcpServers: RunManifestMcpServer[],
): RunManifestV1 {
  const stages = manifest.stages.map((stage) => {
    if (stage.stage_id !== stageId) return stage;
    return { ...stage, mcp_servers: mcpServers };
  });
  const has = stages.some((s) => s.stage_id === stageId);
  if (!has) {
    stages.push({
      stage_id: stageId,
      model: { authored: "", authored_tier: "stage" },
      mcp_servers: mcpServers,
    });
  }
  return { ...manifest, stages };
}

export function withSkillEntry(
  manifest: RunManifestV1,
  skill: RunManifestSkill,
): RunManifestV1 {
  const skills = [...manifest.skills];
  const idx = skills.findIndex((s) => s.name === skill.name);
  if (idx >= 0) skills[idx] = skill;
  else skills.push(skill);
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return { ...manifest, skills };
}

export function finaliseRunManifest(
  manifest: RunManifestV1,
  finalisedAt: string = new Date().toISOString(),
): RunManifestV1 {
  return { ...manifest, finalised_at: finalisedAt };
}

export async function readParsedRunManifest(
  store: Pick<RunStore, "readRunMeta">,
  runId: string,
): Promise<RunManifest | null> {
  const meta = await store.readRunMeta(runId);
  return parseRunManifest(meta.run_manifest);
}

export async function patchRunManifest(
  store: Pick<RunStore, "readRunMeta" | "updateRunManifest">,
  runId: string,
  mutate: (current: RunManifestV1) => RunManifestV1,
  namedSecrets?: readonly NamedSecret[],
): Promise<RunManifestV1 | null> {
  const current = await readParsedRunManifest(store, runId);
  if (current === null || current.manifest_version !== 1) return null;
  const next = redactRunManifest(mutate(current), {
    namedSecrets: namedSecrets ?? getNamedSecrets(),
  });
  await store.updateRunManifest(runId, next);
  return next;
}

export async function finaliseStoredRunManifest(
  store: Pick<RunStore, "readRunMeta" | "updateRunManifest">,
  runId: string,
  finalisedAt: string = new Date().toISOString(),
): Promise<void> {
  await patchRunManifest(store, runId, (m) =>
    m.finalised_at !== undefined ? m : finaliseRunManifest(m, finalisedAt),
  );
}
