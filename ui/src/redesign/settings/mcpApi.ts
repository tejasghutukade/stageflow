import {
  completeMcpOAuthSignIn,
  deleteMcpSecretValue,
  deleteProjectMcpServer,
  fetchMcpOAuthStatus,
  fetchMcpSecrets,
  fetchProjectMcp,
  fetchProjectMcpServer,
  fetchProjectMcpTools,
  importProjectMcp,
  postProjectMcpProbe,
  saveProjectMcpServer,
  setMcpSecretValue,
  signOutMcpOAuth,
  startMcpOAuthSignIn,
  type McpOAuthStatus,
  type McpSecretsList,
  type McpToolInfo,
  type ProjectMcpCatalogList,
  type ProjectMcpImportResult,
  type ProjectMcpProbeResult,
  type ProjectMcpSaveResult,
  type ProjectMcpServerConfig,
} from "../../api";

/** Everything the project-MCP UI asks of the Host. Components and the session take this so tests can pass a fake. */
export type ProjectMcpApi = {
  list: () => Promise<ProjectMcpCatalogList>;
  getServer: (name: string) => Promise<{ name: string; origin: "console"; config: ProjectMcpServerConfig }>;
  save: (name: string, config: ProjectMcpServerConfig) => Promise<ProjectMcpSaveResult>;
  remove: (name: string) => Promise<{ name: string }>;
  importJson: (json: unknown) => Promise<ProjectMcpImportResult>;
  probe: (name: string, init?: { signal?: AbortSignal }) => Promise<ProjectMcpProbeResult>;
  tools: (name: string) => Promise<{ name: string; tools: McpToolInfo[] | null }>;
  oauthStatus: (name: string) => Promise<{ name: string; status: McpOAuthStatus }>;
  oauthStart: (name: string) => Promise<{ name: string; authorizationUrl: string }>;
  oauthComplete: (name: string, input: string) => Promise<{ name: string; status: McpOAuthStatus }>;
  oauthRemove: (name: string) => Promise<{ name: string; status: McpOAuthStatus }>;
  secrets: () => Promise<McpSecretsList>;
  setSecret: (name: string, value: string) => Promise<{ name: string }>;
  removeSecret: (name: string) => Promise<{ name: string }>;
};

export const projectMcpApi: ProjectMcpApi = {
  list: fetchProjectMcp,
  getServer: fetchProjectMcpServer,
  save: saveProjectMcpServer,
  remove: deleteProjectMcpServer,
  importJson: importProjectMcp,
  probe: postProjectMcpProbe,
  tools: fetchProjectMcpTools,
  oauthStatus: fetchMcpOAuthStatus,
  oauthStart: startMcpOAuthSignIn,
  oauthComplete: completeMcpOAuthSignIn,
  oauthRemove: signOutMcpOAuth,
  secrets: fetchMcpSecrets,
  setSecret: setMcpSecretValue,
  removeSecret: deleteMcpSecretValue,
};
