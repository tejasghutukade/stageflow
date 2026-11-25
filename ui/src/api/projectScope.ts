export type ScopedSurface = "agents" | "functions" | "skills";

const scopes = new Map<ScopedSurface, string>();

export function getSurfaceScope(surface: ScopedSurface): string | undefined {
  return scopes.get(surface);
}

export function setSurfaceScope(surface: ScopedSurface, projectRoot: string | undefined): void {
  if (projectRoot === undefined || projectRoot === "") scopes.delete(surface);
  else scopes.set(surface, projectRoot);
}

export function withSurfaceScope(path: string, surface: ScopedSurface): string {
  const root = scopes.get(surface);
  if (root === undefined || /[?&]project_root=/.test(path)) return path;
  const hash = path.indexOf("#");
  const base = hash === -1 ? path : path.slice(0, hash);
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}${new URLSearchParams({ project_root: root })}`;
}
