import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { cursorMcpConfigJson, mcpEndpointUrl } from "../mcpConnect";

export function SettingsMcp() {
  const url = mcpEndpointUrl(window.location, {
    viteDev: import.meta.env.DEV,
  });
  const snippet = cursorMcpConfigJson(url);

  return (
    <section className="card">
      <div className="card__head">
        <h2>MCP</h2>
      </div>
      <p style={{ margin: 0, color: "var(--color-text-secondary)", fontSize: "var(--font-size-sm)" }}>
        This console process also serves Streamable HTTP MCP on localhost.
        Cursor connects with a URL. There is no stdio command, and the
        endpoint dies when this process stops.
      </p>

      <div className="setting">
        <span>
          <strong>Endpoint</strong>
          <p>
            Same host as this console, path{" "}
            <span className="mono">/mcp</span>. Loopback only. No API key.
          </p>
        </span>
        <span className="mono" style={{ wordBreak: "break-all" }}>
          {url}
        </span>
      </div>

      <ol className="steps">
        <li>
          <span>Keep this operator console running. MCP is not a second server.</span>
        </li>
        <li>
          <span>
            Open Cursor Settings → MCP, or add{" "}
            <span className="mono">.cursor/mcp.json</span> in this project.
          </span>
        </li>
        <li>
          <span>
            Paste the snippet below. Use <span className="mono">url</span>, not{" "}
            <span className="mono">command</span>.
          </span>
        </li>
        <li>
          <span>
            Reload MCP in Cursor. Tools that should appear:{" "}
            <span className="mono">list_pipelines</span>,{" "}
            <span className="mono">start_run</span>,{" "}
            <span className="mono">get_run</span>,{" "}
            <span className="mono">get_health</span>,{" "}
            <span className="mono">list_runs</span>,{" "}
            <span className="mono">read_artifact</span>.
          </span>
        </li>
      </ol>

      <CodeBlock
        code={snippet}
        language="json"
        title=".cursor/mcp.json"
        container="section"
        hasLanguageLabel={false}
        width="100%"
      />

      <p className="muted" style={{ margin: "var(--spacing-4) 0 0", fontSize: "var(--font-size-sm)" }}>
        {import.meta.env.DEV
          ? "Vite hot-reload cannot serve MCP. This snippet uses the default sf ui URL. If that process used --port, paste the MCP endpoint printed on boot."
          : "This URL is this console's origin plus /mcp. It must match the MCP endpoint line printed on boot."}
      </p>
      <p className="muted" style={{ margin: "var(--spacing-2) 0 0", fontSize: "var(--font-size-sm)" }}>
        Held-stage answers stay in this console. MCP can start and inspect
        runs; it cannot submit an answer.
      </p>
    </section>
  );
}
