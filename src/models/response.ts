import type { RunStore } from "../runstore/port.js";
import { listModelsMultiProject } from "../config/multiProjectCatalog.js";
import { getModelCatalog, type CatalogProvider } from "./catalog.js";

export type ModelsResponse = {
  /** Catalog ids plus ids pipelines already use, sorted. Back-compatible with the old flat list. */
  models: string[];
  /** Connected providers with their models. */
  providers: CatalogProvider[];
  /** The model a new chat, stage or agent starts on. */
  default: string;
  fetchedAt: string;
  /** Ids pipelines use that no connected provider lists. They still run; pickers warn. */
  unlisted: string[];
  entries: Array<{ id: string; project_root: string }>;
  root_errors: Awaited<ReturnType<typeof listModelsMultiProject>>["root_errors"];
};

/** The shared answer for GET /api/models, the MCP `list_models` tool and every picker. */
export async function buildModelsResponse(options: {
  store: RunStore;
  cwd: string;
  projectRootFilter?: string | undefined;
  refresh?: boolean;
}): Promise<{ response: ModelsResponse; used: Awaited<ReturnType<typeof listModelsMultiProject>> }> {
  const catalog = getModelCatalog(options.cwd);
  const [snapshot, used, defaultModel] = await Promise.all([
    catalog.snapshot(options.refresh ? { refresh: true } : {}),
    listModelsMultiProject({ store: options.store, bootCwd: options.cwd, projectRootFilter: options.projectRootFilter }),
    catalog.defaultModel(),
  ]);
  const listed = new Set(snapshot.models);
  const unlisted = used.models.filter((id) => !listed.has(id));
  return {
    used,
    response: {
      models: [...new Set([...snapshot.models, ...used.models])].sort((a, b) => a.localeCompare(b)),
      providers: snapshot.providers,
      default: defaultModel,
      fetchedAt: snapshot.fetchedAt,
      unlisted,
      entries: used.items,
      root_errors: used.root_errors,
    },
  };
}
