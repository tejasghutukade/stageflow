import type { ServerResponse } from "node:http";
import { InvalidProfileKeyError } from "../browser/profileStore.js";
import { ProfileCatalogError, type ProfileCatalog } from "../browser/profileCatalog.js";

type Json = (res: ServerResponse, status: number, body: unknown) => void;

/**
 * Saved browser logins: list, show, delete the Host's copy, and unpin a profile from the operator's Chrome.
 * Responses carry sites, times and flags only: never cookies, tokens or folder paths.
 */
export async function handleBrowserProfileRoutes(
  method: string,
  pathname: string,
  catalog: ProfileCatalog,
  res: ServerResponse,
  json: Json,
): Promise<boolean> {
  const match = pathname.match(/^\/api\/browser\/profiles(?:\/([^/]+)(\/pin)?)?$/);
  if (match === null) return false;
  try {
    if (match[1] === undefined) {
      if (method !== "GET") return false;
      json(res, 200, { profiles: await catalog.list() });
      return true;
    }
    let name: string;
    try {
      name = decodeURIComponent(match[1]);
    } catch {
      json(res, 400, { code: "invalid_profile_name", error: "Invalid profile name" });
      return true;
    }
    if (match[2] === undefined && method === "GET") {
      json(res, 200, await catalog.get(name));
      return true;
    }
    if (match[2] === undefined && method === "DELETE") {
      await catalog.remove(name);
      json(res, 200, { deleted: true, name });
      return true;
    }
    if (match[2] === "/pin" && method === "DELETE") {
      json(res, 200, await catalog.unpin(name));
      return true;
    }
  } catch (error) {
    if (error instanceof ProfileCatalogError) {
      json(res, error.status, { code: error.code, error: error.message });
      return true;
    }
    if (error instanceof InvalidProfileKeyError) {
      json(res, 400, { code: error.code, error: error.message });
      return true;
    }
    json(res, 500, { code: "browser_profiles_failed", error: "Browser profiles request failed" });
    return true;
  }
  return false;
}
