import http from "node:http";
import { pathToFileURL } from "node:url";

const PAGE = (body) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>Fixture site</title></head><body>${body}</body></html>`;

export function createFixtureServer() {
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const cookies = String(req.headers.cookie ?? "");
    const loggedIn = /(?:^|;\s*)fixture_login=1(?:;|$)/.test(cookies);

    if (url.pathname === "/login") {
      const form = `<h1>Fixture login</h1><form method="get" action="/login"><input type="hidden" name="go" value="1"><button type="submit">Log in</button></form>`;
      if (url.searchParams.get("go") === "1" || req.method === "POST") {
        res.writeHead(302, {
          location: "/home",
          "set-cookie": [
            "fixture_login=1; Path=/; HttpOnly; Max-Age=31536000",
            "fixture_session=1; Path=/; HttpOnly",
          ],
        });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(PAGE(form));
      return;
    }

    if (url.pathname === "/home") {
      if (!loggedIn) {
        res.writeHead(302, { location: "/login" });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(PAGE("<h1>Welcome</h1><p>You are logged in to the fixture site.</p>"));
      return;
    }

    res.writeHead(302, { location: "/home" });
    res.end();
  });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 4173);
  createFixtureServer().listen(port, "127.0.0.1", () => {
    console.log(`Fixture site on http://localhost:${port}`);
  });
}
