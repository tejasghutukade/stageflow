export type ScopedSurface = "agents" | "functions";

/** Console route prefix each surface owns. A scope only lives while the console is on that surface's routes. */
const SURFACE_ROUTES: Record<ScopedSurface, string> = { agents: "#/agents", functions: "#/functions" };

const scopes = new Map<ScopedSurface, string>();

export function getSurfaceScope(surface: ScopedSurface): string | undefined {
  return scopes.get(surface);
}

export function setSurfaceScope(surface: ScopedSurface, projectRoot: string | undefined): void {
  if (projectRoot === undefined || projectRoot === "") scopes.delete(surface);
  else scopes.set(surface, projectRoot);
}

/** Drops the scope of every surface the hash no longer belongs to, so pollers elsewhere read the default project. */
export function clearScopesOutside(hash: string): void {
  for (const surface of Object.keys(SURFACE_ROUTES) as ScopedSurface[]) {
    const prefix = SURFACE_ROUTES[surface];
    if (hash !== prefix && !hash.startsWith(`${prefix}/`) && !hash.startsWith(`${prefix}?`)) scopes.delete(surface);
  }
}

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("hashchange", () => clearScopesOutside(window.location.hash));
}

export function withSurfaceScope(path: string, surface: ScopedSurface): string {
  const root = scopes.get(surface);
  if (root === undefined || /[?&]project_root=/.test(path)) return path;
  const hash = path.indexOf("#");
  const base = hash === -1 ? path : path.slice(0, hash);
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}${new URLSearchParams({ project_root: root })}`;
}
