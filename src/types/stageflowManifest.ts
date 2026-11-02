import type { IndependenceLevel } from "./stage.js";

export type StageflowManifestVersion = 1;

export type StageflowManifestCatalog = {
  pipelines: string[];
  tasks: string[];
  triggers?: string[];
  evals?: string[];
  datasets?: string[];
  patterns?: {
    pipeline?: string;
    task?: string;
    trigger?: string;
    eval?: string;
    dataset?: string | string[];
  };
  exclude?: string[];
};

export type StageflowManifest = {
  version: StageflowManifestVersion;
  catalog: StageflowManifestCatalog;
  /** Default StagePort backend for every pipeline/stage that doesn't override it. */
  agent?: string;
  /** Default LLM model id for every stage that doesn't override it at pipeline or stage level. */
  model?: string;
  /** Default independence for stages that omit it on the stage and the root pipeline. */
  independence?: IndependenceLevel;
};

export type LoadedManifest = {
  path: string;
  projectRoot: string;
  manifest: StageflowManifest;
  patterns: {
    pipeline: string;
    task: string;
    trigger: string;
    eval: string;
    dataset: string[];
  };
};
