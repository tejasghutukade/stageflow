import path from "node:path";
import {
  DefaultPackageManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

export type PackageScope = "user" | "project";

export type ExtensionFileScope = "user" | "project" | "temporary";

export type PackageListing = {
  source: string;
  scope: PackageScope;
  filtered: boolean;
  installedPath?: string;
};

export type ExtensionFileListing = {
  name: string;
  path: string;
  scope: ExtensionFileScope;
  source: string;
  origin: "package" | "top-level";
  baseDir?: string;
  enabled: boolean;
};

export type ExtensionCatalog = {
  packages: PackageListing[];
  extensions: ExtensionFileListing[];
};

export type ListExtensionsOptions = {
  cwd: string;
  agentDir: string;
};

function listingName(filePath: string): string {
  return path.basename(filePath).replace(/\.(ts|js)$/i, "");
}

export async function listExtensions(
  options: ListExtensionsOptions,
): Promise<ExtensionCatalog> {
  const settingsManager = SettingsManager.create(options.cwd, options.agentDir, {
    projectTrusted: true,
  });
  const packageManager = new DefaultPackageManager({
    cwd: options.cwd,
    agentDir: options.agentDir,
    settingsManager,
  });

  const packages = packageManager.listConfiguredPackages().map((pkg) => ({
    source: pkg.source,
    scope: pkg.scope,
    filtered: pkg.filtered,
    ...(pkg.installedPath !== undefined
      ? { installedPath: pkg.installedPath }
      : {}),
  }));
  packages.sort((a, b) => {
    const bySource = a.source.localeCompare(b.source);
    if (bySource !== 0) return bySource;
    return a.scope.localeCompare(b.scope);
  });

  const resolved = await packageManager.resolve(async () => "skip");
  const extensions = resolved.extensions
    .filter((entry) => entry.enabled)
    .map((entry) => ({
      name: listingName(entry.path),
      path: entry.path,
      scope: entry.metadata.scope,
      source: entry.metadata.source,
      origin: entry.metadata.origin,
      ...(entry.metadata.baseDir !== undefined
        ? { baseDir: entry.metadata.baseDir }
        : {}),
      enabled: true as const,
    }));
  extensions.sort((a, b) => {
    const byName = a.name.localeCompare(b.name);
    if (byName !== 0) return byName;
    return a.path.localeCompare(b.path);
  });

  return { packages, extensions };
}
