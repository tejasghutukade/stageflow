import { useCallback, useEffect, useState } from "react";
import {
  fetchExtensions,
  type ExtensionFileListing,
  type PackageListing,
} from "../api";
import { extensionFilePath, extensionPackagePath } from "../routes";

export function ExtensionsPage({
  packageScope,
  packageSource,
  filePath,
}: {
  packageScope?: "user" | "project";
  packageSource?: string;
  filePath?: string;
}) {
  const [packages, setPackages] = useState<PackageListing[]>([]);
  const [extensions, setExtensions] = useState<ExtensionFileListing[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const result = await fetchExtensions();
      setPackages(result.packages);
      setExtensions(result.extensions);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (packageScope && packageSource) {
    const selected =
      packages.find(
        (pkg) => pkg.scope === packageScope && pkg.source === packageSource,
      ) ?? null;
    return (
      <PackageDetail
        scope={packageScope}
        source={packageSource}
        pkg={selected}
        loading={loading}
        error={error}
      />
    );
  }

  if (filePath) {
    const selected =
      extensions.find((ext) => ext.path === filePath) ?? null;
    return (
      <FileDetail
        filePath={filePath}
        file={selected}
        loading={loading}
        error={error}
      />
    );
  }

  const empty = !loading && packages.length === 0 && extensions.length === 0;

  return (
    <div className="main__inner main__inner--wide">
      <div className="page-head">
        <div>
          <h1>Extensions</h1>
          <p>
            Extensions the Pi SDK can discover on this machine. Factory stages
            do not load them.
          </p>
        </div>
      </div>

      {error ? (
        <p style={{ color: "var(--color-text-red)" }}>{error}</p>
      ) : null}
      {loading ? <p className="muted">Loading extensions…</p> : null}
      {empty ? (
        <p className="muted">
          No extensions found under ~/.pi/agent/extensions, this project's
          .pi/extensions, or packages in Pi settings.
        </p>
      ) : null}

      {!loading && packages.length > 0 ? (
        <>
          <h3>Packages</h3>
          <table className="table">
            <thead>
              <tr>
                <th>Source</th>
                <th>Scope</th>
                <th>Installed</th>
              </tr>
            </thead>
            <tbody>
              {packages.map((pkg) => (
                <tr key={`${pkg.scope}:${pkg.source}`}>
                  <td>
                    <a
                      href={`#${extensionPackagePath(pkg.scope, pkg.source)}`}
                    >
                      {pkg.source}
                    </a>
                  </td>
                  <td className="mono">{pkg.scope}</td>
                  <td className="mono">
                    {pkg.installedPath ?? "not installed"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}

      {!loading && extensions.length > 0 ? (
        <>
          <h3>Files</h3>
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Scope</th>
                <th>Source</th>
                <th>Origin</th>
              </tr>
            </thead>
            <tbody>
              {extensions.map((ext) => (
                <tr key={`${ext.scope}:${ext.path}`}>
                  <td>
                    <a href={`#${extensionFilePath(ext.path)}`}>{ext.name}</a>
                  </td>
                  <td className="mono">{ext.scope}</td>
                  <td className="mono">{ext.source}</td>
                  <td className="mono">{ext.origin}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}
    </div>
  );
}

function PackageDetail({
  scope,
  source,
  pkg,
  loading,
  error,
}: {
  scope: "user" | "project";
  source: string;
  pkg: PackageListing | null;
  loading: boolean;
  error: string | null;
}) {
  return (
    <div className="main__inner">
      <p className="crumbs">
        <a href="#/extensions">Extensions</a> / {source}
      </p>

      <div className="page-head">
        <div>
          <h1>{source}</h1>
          <p className="mono">
            {pkg ? `${pkg.scope} · package` : `${scope} · package`}
          </p>
        </div>
      </div>

      {error ? (
        <p style={{ color: "var(--color-text-red)" }}>{error}</p>
      ) : null}
      {loading ? <p className="muted">Loading…</p> : null}
      {!loading && !pkg ? (
        <p className="muted">
          {source} is not in the Pi package catalog on this machine.
        </p>
      ) : null}

      {pkg ? (
        <>
          <p className="muted" style={{ fontSize: "var(--font-size-sm)" }}>
            Scope
          </p>
          <p className="mono">{pkg.scope}</p>
          <p className="muted" style={{ fontSize: "var(--font-size-sm)" }}>
            Source
          </p>
          <p className="mono">{pkg.source}</p>
          <p className="muted" style={{ fontSize: "var(--font-size-sm)" }}>
            Filtered
          </p>
          <p className="mono">{pkg.filtered ? "yes" : "no"}</p>
          <p className="muted" style={{ fontSize: "var(--font-size-sm)" }}>
            Installed path
          </p>
          <p className="mono">{pkg.installedPath ?? "not installed"}</p>
        </>
      ) : null}
    </div>
  );
}

function FileDetail({
  filePath,
  file,
  loading,
  error,
}: {
  filePath: string;
  file: ExtensionFileListing | null;
  loading: boolean;
  error: string | null;
}) {
  const title = file?.name ?? filePath;
  return (
    <div className="main__inner">
      <p className="crumbs">
        <a href="#/extensions">Extensions</a> / {title}
      </p>

      <div className="page-head">
        <div>
          <h1>{title}</h1>
          <p className="mono">
            {file ? `${file.scope} · ${file.source}` : filePath}
          </p>
        </div>
      </div>

      {error ? (
        <p style={{ color: "var(--color-text-red)" }}>{error}</p>
      ) : null}
      {loading ? <p className="muted">Loading…</p> : null}
      {!loading && !file ? (
        <p className="muted">
          This path is not in the Pi extension catalog on this machine.
        </p>
      ) : null}

      {file ? (
        <>
          <p className="muted" style={{ fontSize: "var(--font-size-sm)" }}>
            Scope
          </p>
          <p className="mono">{file.scope}</p>
          <p className="muted" style={{ fontSize: "var(--font-size-sm)" }}>
            Source
          </p>
          <p className="mono">{file.source}</p>
          <p className="muted" style={{ fontSize: "var(--font-size-sm)" }}>
            Origin
          </p>
          <p className="mono">{file.origin}</p>
          <p className="muted" style={{ fontSize: "var(--font-size-sm)" }}>
            File path
          </p>
          <p className="mono">{file.path}</p>
          {file.baseDir ? (
            <>
              <p
                className="muted"
                style={{ fontSize: "var(--font-size-sm)" }}
              >
                Base dir
              </p>
              <p className="mono">{file.baseDir}</p>
            </>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
