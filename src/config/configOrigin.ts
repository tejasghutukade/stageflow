export type ConfigOriginKind = "catalog" | "inline" | "workspace" | "seeded";

export type ConfigOriginRecord = {
  name: string;
  origin: ConfigOriginKind;
  path?: string;
};

export type BindingKindForOrigin = "repository" | "checkout" | "none";

export type TrustWorkspaceDecision = {
  allow: boolean;
  origin: ConfigOriginKind;
  code?: "untrusted_config_origin";
  message?: string;
};

/**
 * Decide whether workspace-sourced config (.mcp.json / skills under checkout)
 * is permitted. Default: refuse for repository bindings; allow for checkout;
 * host trust_workspace_config can allowlisted roots.
 */
export function decideWorkspaceConfigTrust(options: {
  bindingKind: BindingKindForOrigin;
  projectRoot: string;
  trustWorkspaceConfig?: string[];
  source: "workspace" | "catalog" | "inline" | "seeded";
}): TrustWorkspaceDecision {
  if (options.source !== "workspace") {
    return { allow: true, origin: options.source };
  }
  const trusted = (options.trustWorkspaceConfig ?? []).some(
    (root) => root === options.projectRoot,
  );
  if (trusted) {
    return { allow: true, origin: "workspace" };
  }
  if (options.bindingKind === "checkout") {
    return { allow: true, origin: "workspace" };
  }
  if (options.bindingKind === "repository") {
    return {
      allow: false,
      origin: "workspace",
      code: "untrusted_config_origin",
      message: `Workspace config is not trusted for repository binding at ${options.projectRoot}; set trust_workspace_config in HostConfig to allowlist this root`,
    };
  }
  return {
    allow: false,
    origin: "workspace",
    code: "untrusted_config_origin",
    message: `Workspace config is not trusted at ${options.projectRoot}`,
  };
}
