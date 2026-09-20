import { createHash, timingSafeEqual } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { loadPipeline } from "../config/loadPipeline.js";
import { compilePayloadSchema, isPayloadSchemaSubset } from "../envelope/payloadSchema.js";
import type { LoadedPipeline } from "../types/pipeline.js";

const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/);
const publicationSchema = z.object({
  id: identifier,
  name: z.string().trim().min(1),
  description: z.string().trim().min(1),
  project_root: z.string().min(1),
  pipeline: z.string().min(1),
  goal: z.string().trim().min(1),
  allowed_callers: z.array(identifier).min(1),
  input_schema: z.string().min(1),
  results: z.object({
    stage: identifier,
    include_payload: z.boolean().default(true),
    artifacts: z.array(z.string().regex(/^[^/\\.][^/\\]*$/)).default([]),
  }).strict(),
  caller_answerable_stages: z.array(identifier).default([]),
}).strict();

const configSchema = z.object({
  version: z.literal(1),
  public_url: z.string().url(),
  callers: z.array(z.object({
    id: identifier,
    token_env: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  }).strict()).min(1),
  publications: z.array(publicationSchema).min(1),
}).strict();

export type PublicationConfig = z.infer<typeof publicationSchema>;
export type Publication = PublicationConfig & {
  revision: string;
  inputSchema: Record<string, unknown>;
  outputSchema: unknown;
};

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function requireUnique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`Duplicate ${label}`);
}

function publicUrl(value: string): string {
  const url = new URL(value);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(local && url.protocol === "http:")) ||
      url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("public_url must be an HTTPS origin (HTTP allowed on loopback)");
  }
  return url.origin;
}

function validatePublication(config: PublicationConfig, loaded: LoadedPipeline, input: unknown): void {
  const result = loaded.stages.find((stage) => stage.id === config.results.stage);
  if (!result || loaded.dag.childrenOf[result.id]?.length ||
      loaded.dag.nodes.some((node) => node.clone_cap !== undefined)) {
    throw new Error(`Publication ${config.id} requires a fixed terminal result stage without cloning`);
  }
  for (const root of loaded.dag.roots) {
    const stage = loaded.stages.find((candidate) => candidate.id === root)!;
    if (!isPayloadSchemaSubset(stage.clone_input_schema, input)) {
      throw new Error(`Publication ${config.id} input is incompatible with entry stage ${root}`);
    }
  }
  for (const id of config.caller_answerable_stages) {
    const stage = loaded.stages.find((candidate) => candidate.id === id);
    if (!stage || stage.gate_kinds?.length !== 1 || stage.gate_kinds[0] !== "free_text") {
      throw new Error(`Publication ${config.id} caller-answerable stage ${id} must allow only free_text`);
    }
  }
  const declared = new Set(result.pre_emit_checks?.flatMap((check) =>
    check.type === "artifact_declared" ? check.basename : []) ?? []);
  for (const name of config.results.artifacts) {
    if (!declared.has(name)) throw new Error(`Publication ${config.id} artifact ${name} needs an emit artifact check`);
  }
}

async function readPublication(config: PublicationConfig): Promise<Publication> {
  const loaded = await loadPipeline(config.pipeline, { cwd: config.project_root, projectRoot: config.project_root });
  const input: unknown = JSON.parse(await readFile(config.input_schema, "utf8"));
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error(`Publication ${config.id} needs an object schema`);
  compilePayloadSchema(input);
  validatePublication(config, loaded, input);
  const files = [...new Set([loaded.pipelinePath, ...Object.values(loaded.stageSources ?? {})
    .flatMap((source) => source.kind === "file" ? [source.path] : [])])].sort();
  const bodies = await Promise.all(files.map(async (file) => [file, await readFile(file, "utf8")]));
  const revision = digest(JSON.stringify({ config, loaded, input, bodies })).toString("hex");
  return {
    ...config,
    revision,
    inputSchema: input as Record<string, unknown>,
    outputSchema: loaded.stages.find((stage) => stage.id === config.results.stage)!.payload_schema,
  };
}

export class PublicationRegistry {
  constructor(
    readonly publicUrl: string,
    readonly configPath: string,
    private readonly publications: readonly Publication[],
    private readonly credentials: readonly { id: string; hash: Buffer }[],
  ) {}

  authenticate(authorization: string | undefined): string | undefined {
    const match = authorization?.match(/^Bearer ([^\s]+)$/i);
    if (!match) return undefined;
    const hash = digest(match[1]);
    return this.credentials.find((credential) => timingSafeEqual(credential.hash, hash))?.id;
  }

  list(caller: string): Publication[] {
    return this.publications.filter((publication) => publication.allowed_callers.includes(caller))
      .map((publication) => structuredClone(publication));
  }

  get(caller: string, id: string): Publication | undefined {
    return this.list(caller).find((publication) => publication.id === id);
  }

  summaries(): Array<{ id: string; name: string; revision: string }> {
    return this.publications.map(({ id, name, revision }) => ({ id, name, revision }));
  }

  async assertUnchanged(caller: string, id: string): Promise<void> {
    const publication = this.get(caller, id);
    if (!publication) throw new Error("Publication not found");
    const { revision: _revision, inputSchema: _input, outputSchema: _output, ...config } = publication;
    const current = await readPublication(config);
    if (current.revision !== publication.revision) throw new Error("Publication changed; reload the deployed configuration");
  }
}

export async function loadPublicationRegistry(
  configPath: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PublicationRegistry> {
  const absolute = await realpath(configPath);
  const config = configSchema.parse(parse(await readFile(absolute, "utf8")));
  const origin = publicUrl(config.public_url);
  requireUnique(config.callers.map((caller) => caller.id), "caller ID");
  requireUnique(config.publications.map((publication) => publication.id), "publication ID");
  const credentials = config.callers.map((caller) => {
    const token = env[caller.token_env];
    if (!token || /\s/.test(token) || token.length < 32) throw new Error(`Caller ${caller.id} requires a token of at least 32 characters in ${caller.token_env}`);
    return { id: caller.id, hash: digest(token) };
  });
  requireUnique(credentials.map((credential) => credential.hash.toString("hex")), "caller credential");
  const publications: Publication[] = [];
  for (const entry of config.publications) {
    requireUnique(entry.allowed_callers, `caller in publication ${entry.id}`);
    requireUnique(entry.results.artifacts, `artifact in publication ${entry.id}`);
    requireUnique(entry.caller_answerable_stages, `answerable stage in publication ${entry.id}`);
    if (entry.allowed_callers.some((id) => !credentials.some((caller) => caller.id === id))) {
      throw new Error(`Publication ${entry.id} refers to an unknown caller`);
    }
    const root = await realpath(path.resolve(path.dirname(absolute), entry.project_root));
    publications.push(await readPublication({
      ...entry, project_root: root,
      pipeline: await realpath(path.resolve(root, entry.pipeline)),
      input_schema: await realpath(path.resolve(root, entry.input_schema)),
    }));
  }
  return new PublicationRegistry(origin, absolute, publications, credentials);
}
