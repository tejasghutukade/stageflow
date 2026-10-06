import { useEffect, useState } from "react";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { cursorMcpConfigJson, mcpEndpointUrl } from "../mcpConnect";
import { getControlToken, setControlToken } from "../api/controlToken";

export function SettingsMcp() {
  const url = mcpEndpointUrl(window.location, {
    viteDev: import.meta.env.DEV,
  });
  const snippet = cursorMcpConfigJson(url);
  const [token, setToken] = useState(() => getControlToken());

  useEffect(() => {
    setControlToken(token);
  }, [token]);

  return (
    <section className="card">
      <div className="card__head">
        <h2>Operator-host MCP</h2>
      </div>
      <p style={{ margin: 0, color: "var(--color-text-secondary)", fontSize: "var(--font-size-sm)" }}>
        This console process also serves Streamable HTTP MCP on the same origin.
        Cursor connects with a URL. There is no stdio command, and the
        endpoint dies when this process stops.
      </p>

      <div className="setting">
        <span>
          <strong>Endpoint</strong>
          <p>
            Same host as this console, path{" "}
            <span className="mono">/mcp</span>. When the Host is bound off
            loopback, send{" "}
            <span className="mono">Authorization: Bearer</span> with the control
            token below (drive scope).
          </p>
        </span>
        <span className="mono" style={{ wordBreak: "break-all" }}>
          {url}
        </span>
      </div>

      <div className="setting">
        <span>
          <strong>Control token</strong>
          <p>
            Stored in this browser only (<span className="mono">localStorage</span>).
            Leave empty for local loopback Hosts that run without{" "}
            <span className="mono">STAGEFLOW_CONTROL_TOKEN</span>.
          </p>
        </span>
        <input
          type="password"
          autoComplete="off"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="STAGEFLOW_CONTROL_TOKEN"
          style={{ minWidth: "16rem" }}
        />
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
            <span className="mono">command</span>. Remote clients also need the
            bearer control token.
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
            <span className="mono">read_artifact</span>,{" "}
            <span className="mono">wait_run</span>,{" "}
            <span className="mono">answer_gate</span>,{" "}
            <span className="mono">decide_feedback_loop</span>,{" "}
            <span className="mono">describe_pipeline</span>,{" "}
            <span className="mono">validate</span>,{" "}
            <span className="mono">list_providers</span>,{" "}
            <span className="mono">list_models</span>,{" "}
            <span className="mono">list_project_mcp</span>,{" "}
            <span className="mono">probe_project_mcp</span>.
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
        MCP can submit a waiting-stage answer (<span className="mono">answer_gate</span>)
        and a feedback-loop decision (<span className="mono">decide_feedback_loop</span>).
      </p>
    </section>
  );
}
