import path from "node:path";

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

export function bindingKindForOrigin(
  kind: "repository" | "checkout" | "unbound" | "none" | undefined,
): BindingKindForOrigin {
  if (kind === "repository" || kind === "checkout") return kind;
  return "none";
}

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

function isUnderRoot(candidate: string, root: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(candidate);
  const rel = path.relative(resolvedRoot, resolved);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function skillOriginKind(
  scope: "user" | "project" | "temporary",
  filePath: string,
  checkoutRoot: string | undefined,
): ConfigOriginKind {
  if (scope === "temporary") return "inline";
  if (
    scope === "project" &&
    checkoutRoot !== undefined &&
    isUnderRoot(filePath, checkoutRoot)
  ) {
    return "workspace";
  }
  return "catalog";
}

export function catalogOrSeededOrigin(
  projectRoot: string | undefined,
  seededRoots: readonly string[],
): ConfigOriginKind {
  if (projectRoot !== undefined && seededRoots.some((root) => root === projectRoot)) {
    return "seeded";
  }
  return "catalog";
}
