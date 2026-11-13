import { LuPlus } from "react-icons/lu";
import { Button, Field, Segmented, SelectField, TextBox, Toggle } from "../agents/ui";
import type { FunctionKind } from "../../api/functions";
import type { FunctionAccessDeclaration, FunctionAccessNetwork } from "@stageflow/function-access";
import { artifactChoices, artifactFromLabel, artifactLabel, effectChoices } from "./functionAccess";
import { Callout, RemoveButton } from "./FunctionFields";
import { accessSummary, type DeclaredAccessState } from "./functionAccessSource";

const READ_METHODS = ["GET"];
const ACTION_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];

function withEffect(entry: FunctionAccessNetwork, effect: "read" | "action"): FunctionAccessNetwork {
  return { ...entry, effect, methods: effect === "action" ? [...ACTION_METHODS] : [...READ_METHODS] };
}

export function FunctionDeclaredAccess({
  kind,
  state,
  onChange,
}: {
  kind: FunctionKind;
  state: Exclude<DeclaredAccessState, { mode: "legacy" }>;
  onChange: (access: FunctionAccessDeclaration) => void;
}) {
  const readOnly = state.mode === "invalid";
  const access = state.mode === "declared" ? state.access : { artifacts: "none" as const, workspace: "none" as const, files: [], env: [], network: [] };
  const artifactOptions = artifactChoices(kind, access.artifacts);
  const workspaceOptions = artifactChoices(kind, access.workspace);

  return (
    <div className="flex flex-col gap-4" data-testid="function-contract">
      {state.mode === "invalid" ? (
        <Callout tone="fail" role="alert">
          {state.issues.map((issue) => (
            <span key={`${issue.line}:${issue.column}:${issue.message}`}>
              {issue.message} ({issue.line}:{issue.column})
            </span>
          ))}
        </Callout>
      ) : (
        <p className={`text-xs leading-[1.4] ${accessSummary(access).startsWith("No access") ? "text-[var(--sf-text-3)]" : "text-[var(--sf-text-2)]"}`}>
          {accessSummary(access)}
        </p>
      )}
      <fieldset disabled={readOnly} className="m-0 flex min-w-0 flex-col gap-4 border-0 p-0">
        <Field label="Artifacts" hint="This run's artifacts.">
          <Segmented
            ariaLabel="Artifacts"
            options={artifactOptions}
            value={artifactLabel(access.artifacts)}
            onChange={(label) => onChange({ ...access, artifacts: artifactFromLabel(label) })}
          />
        </Field>
        <Field label="Workspace" hint="Broad access. This grants the whole workspace root.">
          <Segmented
            ariaLabel="Workspace"
            options={workspaceOptions}
            value={artifactLabel(access.workspace)}
            onChange={(label) => onChange({ ...access, workspace: artifactFromLabel(label) })}
          />
        </Field>
        <Field label="Environment variables" hint="Non-secret values copied into context.env. Secrets such as provider or GitHub tokens are never available here.">
          <div className="flex flex-col gap-2">
            {access.env.length > 0 ? (
              <div className="flex flex-col rounded-lg border border-[var(--sf-hairline)] [&>*+*]:border-t [&>*+*]:border-t-[var(--sf-hairline)]">
                {access.env.map((row, index) => (
                  <div key={`env-${index}`} className="flex items-center gap-3 px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <TextBox
                        mono
                        ariaLabel={`Environment variable ${index + 1}`}
                        value={row.name}
                        placeholder="FEED_REGION"
                        onChange={(name) => onChange({ ...access, env: access.env.map((item, i) => (i === index ? { ...item, name } : item)) })}
                      />
                    </div>
                    <label className="flex shrink-0 items-center gap-2 text-xs leading-[1.33333] text-[var(--sf-text-2)]">
                      <Toggle
                        on={!row.optional}
                        label={`Environment variable ${index + 1} required`}
                        onChange={(required) => onChange({ ...access, env: access.env.map((item, i) => (i === index ? { ...item, optional: !required } : item)) })}
                      />
                      Required
                    </label>
                    <RemoveButton
                      label={`Remove environment variable ${row.name || index + 1}`}
                      onClick={() => onChange({ ...access, env: access.env.filter((_, i) => i !== index) })}
                    />
                  </div>
                ))}
              </div>
            ) : null}
            <div>
              <Button size="sm" icon={<LuPlus aria-hidden />} onClick={() => onChange({ ...access, env: [...access.env, { name: "", optional: false }] })}>
                Add variable
              </Button>
            </div>
          </div>
        </Field>
        <Field label="Network" hint="Calls go through the host: public https only. A credential reference lets the host add a stored credential; your code never sees the secret.">
          <div className="flex flex-col gap-2">
            {access.network.map((row, index) => (
              <div key={`api-${index}`} className="flex flex-col gap-2 rounded-lg border border-[var(--sf-hairline)] p-2.5">
                <div className="flex items-center gap-2">
                  <div className="min-w-0 flex-1">
                    <TextBox
                      mono
                      ariaLabel={`API origin ${index + 1}`}
                      value={row.origin}
                      placeholder="https://api.example.com"
                      onChange={(origin) => onChange({ ...access, network: access.network.map((item, i) => (i === index ? { ...item, origin } : item)) })}
                    />
                  </div>
                  <RemoveButton
                    label={`Remove origin ${row.origin || index + 1}`}
                    onClick={() => onChange({ ...access, network: access.network.filter((_, i) => i !== index) })}
                  />
                </div>
                <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                  <SelectField
                    ariaLabel={`API effect ${index + 1}`}
                    value={row.effect}
                    options={effectChoices(kind, row.effect)}
                    onChange={(effect) => onChange({ ...access, network: access.network.map((item, i) => (i === index ? withEffect(item, effect) : item)) })}
                  />
                  <TextBox
                    mono
                    ariaLabel={`API credential reference ${index + 1}`}
                    value={row.credential ?? ""}
                    placeholder="Credential reference"
                    onChange={(raw) => {
                      const credential = raw.trim();
                      onChange({
                        ...access,
                        network: access.network.map((item, i) => {
                          if (i !== index) return item;
                          const next = { ...item };
                          if (credential) next.credential = credential;
                          else delete next.credential;
                          return next;
                        }),
                      });
                    }}
                  />
                </div>
              </div>
            ))}
            <div>
              <Button
                size="sm"
                icon={<LuPlus aria-hidden />}
                onClick={() => onChange({ ...access, network: [...access.network, { origin: "", effect: "read", methods: [...READ_METHODS], path: "/" }] })}
              >
                Add origin
              </Button>
            </div>
          </div>
        </Field>
        {access.files.length > 0 ? (
          <div className="flex flex-col gap-2">
            <p className="text-xs font-medium leading-[1.33333] text-[var(--sf-text-2)]">Advanced access</p>
            <div className="flex flex-col gap-1">
              {access.files.map((file, index) => (
                <p key={`${file.root}:${file.path}:${index}`} className="text-xs leading-[1.4] text-[var(--sf-text-2)]">
                  {file.access === "write" ? "Write" : "Read"} {file.root} {file.path || "(root)"}
                </p>
              ))}
            </div>
            <p className="text-xs leading-[1.4] text-[var(--sf-text-3)]">Edit these paths in the source.</p>
          </div>
        ) : null}
      </fieldset>
    </div>
  );
}
