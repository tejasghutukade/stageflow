import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { resolveStageflowContext } from "../project/resolveStageflowContext.js";
import { clientAuthorizationHeaders } from "../server/controlToken.js";
import { ensureGlobalService, hostBaseUrl, type EnsureGlobalServiceResult } from "../server/ensureGlobalService.js";

export const AGENTS_USAGE = `Usage:
  sf agents list [--json]
  sf agents get <id> [--json]
  sf agents validate <file.agent.yaml> [--json]
  sf agents enable <id> [--json]
  sf agents disable <id> [--json]
  sf agents history <id> [--json]
  sf agents restore <id> <revision> [--json]
  sf agents sessions <id> [--status <status>] [--json]
  sf agents session <id> <sessionId> [--json]
  sf agents chat <id> --message <text> [--session <sessionId>] [--json]
  sf agents approve <id> <sessionId> [--json]
  sf agents deny <id> <sessionId> [--json]

Talks to the running Stageflow Host for the project in the current directory.`;

export type AgentsCommandIo = {
  log: (line: string) => void;
  error: (line: string) => void;
  write: (chunk: string) => void;
};

const defaultIo: AgentsCommandIo = {
  log: (line) => console.log(line),
  error: (line) => console.error(line),
  write: (chunk) => process.stdout.write(chunk),
};

type Parsed = {
  help: boolean;
  json: boolean;
  subcommand?: string;
  positional: string[];
  message?: string;
  session?: string;
  status?: string;
};

const FLAGS_WITH_VALUE = new Set(["--message", "--session", "--status"]);

function parseArgs(args: string[]): Parsed {
  const parsed: Parsed = { help: false, json: false, positional: [] };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg === "--json") parsed.json = true;
    else if (FLAGS_WITH_VALUE.has(arg)) {
      const value = args[++index];
      if (value === undefined || value.length === 0) throw new Error(`Missing value for ${arg}`);
      if (arg === "--message") parsed.message = value;
      else if (arg === "--session") parsed.session = value;
      else parsed.status = value;
    } else if (arg.startsWith("-")) throw new Error(`Unknown flag: ${arg}`);
    else if (parsed.subcommand === undefined) parsed.subcommand = arg;
    else parsed.positional.push(arg);
  }
  return parsed;
}

class HostError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly issues: Array<{ path: string; message: string }> = [],
  ) {
    super(message);
  }
}

type Client = {
  get<T>(urlPath: string): Promise<T>;
  post<T>(urlPath: string, body?: unknown): Promise<T>;
  stream(urlPath: string, body: unknown, onFrame: (frame: Record<string, unknown>) => void): Promise<void>;
};

function hostClient(base: string, projectRoot: string): Client {
  const withRoot = (urlPath: string) => {
    const url = new URL(urlPath, base);
    url.searchParams.set("project_root", projectRoot);
    return url;
  };
  const fail = async (res: Response): Promise<never> => {
    const body = (await res.json().catch(() => ({}))) as { code?: string; message?: string; issues?: HostError["issues"] };
    throw new HostError(body.code ?? `http_${res.status}`, body.message ?? body.code ?? `Host returned ${res.status}`, body.issues);
  };
  return {
    async get(urlPath) {
      const res = await fetch(withRoot(urlPath), { headers: clientAuthorizationHeaders("GET") });
      if (!res.ok) await fail(res);
      return res.json();
    },
    async post(urlPath, body) {
      const res = await fetch(withRoot(urlPath), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...clientAuthorizationHeaders("POST") },
        body: JSON.stringify(body ?? {}),
      });
      if (!res.ok) await fail(res);
      return res.json();
    },
    async stream(urlPath, body, onFrame) {
      const res = await fetch(withRoot(urlPath), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/x-ndjson",
          ...clientAuthorizationHeaders("POST"),
        },
        body: JSON.stringify(body),
      });
      if (!res.ok || !res.body) await fail(res);
      const decoder = new TextDecoder();
      let buffered = "";
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buffered += decoder.decode(chunk, { stream: true });
        let newline = buffered.indexOf("\n");
        while (newline >= 0) {
          const line = buffered.slice(0, newline).trim();
          buffered = buffered.slice(newline + 1);
          if (line) onFrame(JSON.parse(line) as Record<string, unknown>);
          newline = buffered.indexOf("\n");
        }
      }
    },
  };
}

type AgentRow = { id: string; name: string; enabled: boolean; revision: number; issues: unknown[] };
type RevisionRow = { revision: number; source: string; summary: string | null; createdAt: string };
type SessionRow = { id: string; status: string; source: string; title: string | null; updatedAt: string };

export async function runAgentsCommand(
  args: string[],
  options: {
    io?: Partial<AgentsCommandIo>;
    cwd?: string;
    projectRoot?: string;
    hostBaseUrl?: string;
    ensureService?: () => Promise<EnsureGlobalServiceResult>;
  } = {},
): Promise<number> {
  const io: AgentsCommandIo = { ...defaultIo, ...options.io };
  let parsed: Parsed;
  try {
    parsed = parseArgs(args);
  } catch (error) {
    io.error(error instanceof Error ? error.message : String(error));
    io.error(AGENTS_USAGE);
    return 1;
  }
  if (parsed.help || !parsed.subcommand) {
    io.error(AGENTS_USAGE);
    return parsed.help ? 0 : 1;
  }
  const need = (count: number, what: string): string[] => {
    if (parsed.positional.length !== count) throw new HostError("usage", `${parsed.subcommand} needs ${what}`);
    return parsed.positional;
  };
  const print = (value: unknown, human: () => void) => (parsed.json ? io.log(JSON.stringify(value, null, 2)) : human());

  try {
    const cwd = options.cwd ?? process.cwd();
    const projectRoot = options.projectRoot ?? (await resolveStageflowContext(cwd)).projectRoot;
    const ensured = await (options.ensureService ?? (() => ensureGlobalService()))();
    if (!ensured.ok) throw new HostError("host.unavailable", ensured.message);
    const client = hostClient(options.hostBaseUrl ?? hostBaseUrl(), projectRoot);
    const agentPath = (id: string, tail = "") => `/api/agents/${encodeURIComponent(id)}${tail}`;

    switch (parsed.subcommand) {
      case "list": {
        need(0, "no arguments");
        const { agents } = await client.get<{ agents: AgentRow[] }>("/api/agents");
        print({ agents }, () => {
          for (const agent of agents) {
            const state = agent.issues.length > 0 ? "invalid" : agent.enabled ? "enabled" : "disabled";
            io.log(`${agent.id}\tv${agent.revision}\t${state}\t${agent.name}`);
          }
        });
        return 0;
      }
      case "get": {
        const [id] = need(1, "<id>");
        const detail = await client.get<{ yaml: string | null }>(agentPath(id!));
        print(detail, () => io.log(detail.yaml ?? "(no valid revision)"));
        return 0;
      }
      case "validate": {
        const [file] = need(1, "<file.agent.yaml>");
        const definition = parseYaml(await readFile(path.resolve(cwd, file!), "utf8")) as unknown;
        const result = await client.post<{
          issues: Array<{ path: string; message: string }>;
          warnings: Array<{ path: string; message: string }>;
        }>("/api/agents/validate", { definition });
        print(result, () => {
          for (const issue of result.issues) io.error(`error   ${issue.path || "(file)"}: ${issue.message}`);
          for (const warning of result.warnings) io.error(`warning ${warning.path}: ${warning.message}`);
          if (result.issues.length === 0) io.log("valid");
        });
        return result.issues.length === 0 ? 0 : 1;
      }
      case "enable":
      case "disable": {
        const [id] = need(1, "<id>");
        const detail = await client.post<{ agent: AgentRow }>(agentPath(id!, `/${parsed.subcommand}`));
        print(detail, () => io.log(`${id} ${parsed.subcommand}d (v${detail.agent.revision})`));
        return 0;
      }
      case "history": {
        const [id] = need(1, "<id>");
        const { revisions } = await client.get<{ revisions: RevisionRow[] }>(agentPath(id!, "/revisions"));
        print({ revisions }, () => {
          for (const row of revisions) io.log(`v${row.revision}\t${row.createdAt}\t${row.source}\t${row.summary ?? ""}`);
        });
        return 0;
      }
      case "restore": {
        const [id, raw] = need(2, "<id> <revision>");
        const revision = Number(raw);
        if (!Number.isInteger(revision) || revision < 1) throw new HostError("usage", "revision must be a positive integer");
        const current = await client.get<{ agent: AgentRow }>(agentPath(id!));
        const detail = await client.post<{ agent: AgentRow }>(agentPath(id!, `/revisions/${revision}/restore`), {
          baseRevision: current.agent.revision,
        });
        print(detail, () => io.log(`${id} restored v${revision} as v${detail.agent.revision}`));
        return 0;
      }
      case "sessions": {
        const [id] = need(1, "<id>");
        const query = parsed.status ? `?status=${encodeURIComponent(parsed.status)}` : "";
        const page = await client.get<{ sessions: SessionRow[] }>(agentPath(id!, `/sessions${query}`));
        print(page, () => {
          for (const row of page.sessions) io.log(`${row.id}\t${row.status}\t${row.source}\t${row.updatedAt}\t${row.title ?? ""}`);
        });
        return 0;
      }
      case "session": {
        const [id, sessionId] = need(2, "<id> <sessionId>");
        const detail = await client.get<{ messages: Array<{ role: string; author: string | null; text: string }> }>(
          agentPath(id!, `/sessions/${encodeURIComponent(sessionId!)}`),
        );
        print(detail, () => {
          for (const message of detail.messages) io.log(`${message.author ?? message.role}: ${message.text}\n`);
        });
        return 0;
      }
      case "chat": {
        const [id] = need(1, "<id>");
        if (!parsed.message) throw new HostError("usage", "chat needs --message");
        let failure: HostError | undefined;
        let done: unknown;
        await client.stream(
          agentPath(id!, "/chat"),
          { message: parsed.message, ...(parsed.session ? { sessionId: parsed.session } : {}) },
          (frame) => {
            if (frame.type === "delta" && !parsed.json) io.write(String(frame.text));
            else if (frame.type === "session" && !parsed.json) io.error(`session ${String(frame.sessionId)}`);
            else if (frame.type === "done") done = frame.session;
            else if (frame.type === "error") failure = new HostError(String(frame.code), String(frame.message ?? frame.code));
          },
        );
        if (failure) throw failure;
        if (parsed.json) io.log(JSON.stringify(done, null, 2));
        else io.write("\n");
        return 0;
      }
      case "approve":
      case "deny": {
        const [id, sessionId] = need(2, "<id> <sessionId>");
        const result = await client.post<{ approval: { tool: string } }>(
          agentPath(id!, `/sessions/${encodeURIComponent(sessionId!)}/approval/${parsed.subcommand}`),
        );
        print(result, () => io.log(`${parsed.subcommand === "approve" ? "Approved" : "Denied"} ${result.approval.tool}`));
        return 0;
      }
      default:
        throw new HostError("usage", `Unknown subcommand: ${parsed.subcommand}`);
    }
  } catch (error) {
    if (error instanceof HostError) {
      if (parsed.json) io.log(JSON.stringify({ code: error.code, message: error.message, issues: error.issues }, null, 2));
      else {
        io.error(error.message);
        for (const issue of error.issues) io.error(`  ${issue.path || "(file)"}: ${issue.message}`);
      }
      if (error.code === "usage") io.error(AGENTS_USAGE);
      return 1;
    }
    throw error;
  }
}
