export type McpToolContentBlock = {
  type: string;
  text?: string;
  mimeType?: string;
  data?: string;
};

export type McpCallOptions = {
  signal?: AbortSignal;
  meta?: Record<string, unknown>;
};

export type McpCallResult = {
  status: number;
  isError: boolean;
  payload: any;
  content: McpToolContentBlock[];
  raw: {
    result?: {
      content?: McpToolContentBlock[];
      isError?: boolean;
    };
    error?: unknown;
  };
};

function payloadFromContent(content: McpToolContentBlock[]): unknown {
  const text = content.find((block) => block.type === "text")?.text;
  if (typeof text !== "string" || text === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function mcpCall(
  base: string,
  name: string,
  args: Record<string, unknown> = {},
  opts: McpCallOptions = {},
): Promise<McpCallResult> {
  const params: Record<string, unknown> = { name, arguments: args };
  if (opts.meta !== undefined) {
    params._meta = opts.meta;
  }
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params,
    }),
    signal: opts.signal,
  });
  const text = await res.text();
  const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
  if (!dataLine) {
    throw new Error(`no SSE data in MCP response: ${text.slice(0, 200)}`);
  }
  const raw = JSON.parse(dataLine.slice("data: ".length)) as McpCallResult["raw"];
  const content = raw.result?.content ?? [];
  return {
    status: res.status,
    isError: Boolean(raw.result?.isError),
    payload: payloadFromContent(content),
    content,
    raw,
  };
}
