import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

serveStdio(() => {
  const server = new McpServer({ name: "echo", version: "1.0.0" });
  server.registerTool(
    "echo",
    {
      description: "Echo a text argument back to the caller.",
      inputSchema: z.object({
        text: z.string().describe("Text to echo"),
      }),
    },
    async ({ text }) => ({
      content: [{ type: "text", text }],
    }),
  );
  return server;
});
