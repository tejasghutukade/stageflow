import { createServer } from "node:net";

/** A port the OS just handed out on 127.0.0.1. Random, so parallel test files do not collide on a fixed range. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => (port > 0 ? resolve(port) : reject(new Error("no port"))));
    });
  });
}
