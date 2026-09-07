export type StageflowManifestVersion = 1;

export type StageflowManifestCatalog = {
  pipelines: string[];
  tasks: string[];
  patterns?: {
    pipeline?: string;
    task?: string;
  };
  exclude?: string[];
};

export type StageflowManifest = {
  version: StageflowManifestVersion;
  catalog: StageflowManifestCatalog;
  /** Default AgentPort backend for every pipeline/stage that doesn't override it. */
  agent?: string;
};

export type LoadedManifest = {
  path: string;
  projectRoot: string;
  manifest: StageflowManifest;
  patterns: {
    pipeline: string;
    task: string;
  };
};
