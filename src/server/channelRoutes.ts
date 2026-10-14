import type { ServerResponse } from "node:http";
import type { ChannelService } from "../channels/service.js";

/** Read-only listing plus one live check. Responses carry codes and identifiers, never secrets. */
export async function handleChannelRoutes(
  method: string, pathname: string, service: ChannelService, res: ServerResponse,
  json: (res: ServerResponse, status: number, body: unknown) => void,
): Promise<boolean> {
  if (method === "GET" && pathname === "/api/connections") {
    json(res, 200, service.list());
    return true;
  }
  const match = pathname.match(/^\/api\/connections\/([^/]+)\/check$/);
  if (method === "POST" && match) {
    let id: string;
    try {
      id = decodeURIComponent(match[1]!);
    } catch {
      json(res, 400, { code: "CHANNEL_INVALID_INPUT" });
      return true;
    }
    const health = await service.checkNow(id);
    if (health) json(res, 200, health);
    else json(res, 404, { code: "CHANNEL_NOT_FOUND" });
    return true;
  }
  return false;
}
