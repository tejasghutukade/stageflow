import { useState, type ReactNode } from "react";
import { LuFile, LuGlobe, LuKeyRound, LuPlus } from "react-icons/lu";
import type { FunctionApiCapability, FunctionBinding, FunctionCapability, FunctionFileCapability, FunctionKind } from "../../api/functions";
import { Button, ChipListField, Field, Segmented, SelectField, TextBox, Toggle } from "../agents/ui";
import {
  accessFromDefinition,
  applyAccess,
  artifactChoices,
  artifactFromLabel,
  artifactLabel,
  effectChoices,
  formatAccessSummary,
  nextCapabilityId,
  type FunctionAccess,
} from "./functionAccess";
import { RemoveButton } from "./FunctionFields";

const TYPE_META: Record<FunctionCapability["type"], { label: string; icon: ReactNode; add: string }> = {
  file: { label: "File", icon: <LuFile aria-hidden />, add: "File access" },
  env: { label: "Environment value", icon: <LuKeyRound aria-hidden />, add: "Environment value" },
  api: { label: "API", icon: <LuGlobe aria-hidden />, add: "API access" },
};

const TYPE_OPTIONS = (Object.keys(TYPE_META) as FunctionCapability["type"][]).map((value) => ({ value, label: TYPE_META[value].label }));

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];

function blank(kind: FunctionCapability["type"], capabilities: readonly FunctionCapability[]): FunctionCapability {
  if (kind === "env") return { id: nextCapabilityId("env", capabilities), type: "env", alias: "" };
  if (kind === "api") {
    return {
      id: nextCapabilityId("api", capabilities),
      type: "api",
      origin: "https://example.com",
      methods: ["GET"],
      path_prefix: "/v1",
      effect: "read",
    };
  }
  return { id: nextCapabilityId("file", capabilities), type: "file", root: "workspace", path: "", access: "read" };
}

export function FunctionContractFields({
  kind,
  capabilities,
  bindings,
  onChange,
}: {
  kind: FunctionKind;
  capabilities: FunctionCapability[];
  bindings: FunctionBinding[];
  onChange: (next: { capabilities: FunctionCapability[]; bindings: FunctionBinding[] }) => void;
}) {
  const access = accessFromDefinition(capabilities, bindings, kind);
  const [adderOpen, setAdderOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const writeChoices = artifactChoices(kind, access.artifacts);

  function commit(next: FunctionAccess) {
    onChange(applyAccess({ capabilities, bindings }, next, kind));
  }

  function addAdvanced(type: "file" | "api") {
    setAdvancedOpen(true);
    commit({ ...access, advanced: [...access.advanced, blank(type, capabilities)] });
  }

  return (
    <div className="flex flex-col gap-4" data-testid="function-contract">
      <p className={`text-xs leading-[1.4] ${access.env.length === 0 && access.network.length === 0 && access.artifacts === "none" && access.advanced.length === 0 ? "text-[var(--sf-text-3)]" : "text-[var(--sf-text-2)]"}`}>
        {formatAccessSummary(capabilities)}
      </p>
      <Field label="Artifacts" hint="This run's artifacts. Nothing else on disk is reachable unless you add it under Advanced.">
        <Segmented
          ariaLabel="Artifacts"
          options={writeChoices}
          value={artifactLabel(access.artifacts)}
          onChange={(label) => commit({ ...access, artifacts: artifactFromLabel(label) })}
        />
      </Field>
      <Field label="Environment variables" hint="Non-secret values copied into context.env. Secrets such as provider or GitHub tokens are never available here.">
        <div className="flex flex-col gap-2">
          {access.env.length > 0 ? (
            <div className="flex flex-col rounded-lg border border-[var(--sf-hairline)] [&>*+*]:border-t [&>*+*]:border-t-[var(--sf-hairline)]">
              {access.env.map((row, index) => (
                <div key={row.capabilityId || `env-${index}`} className="flex items-center gap-3 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <TextBox
                      mono
                      ariaLabel={`Environment variable ${index + 1}`}
                      value={row.alias}
                      placeholder="FEED_REGION"
                      onChange={(alias) => commit({ ...access, env: access.env.map((item, i) => (i === index ? { ...item, alias } : item)) })}
                    />
                  </div>
                  <label className="flex shrink-0 items-center gap-2 text-xs leading-[1.33333] text-[var(--sf-text-2)]">
                    <Toggle
                      on={row.required}
                      label={`Environment variable ${index + 1} required`}
                      onChange={(required) => commit({ ...access, env: access.env.map((item, i) => (i === index ? { ...item, required } : item)) })}
                    />
                    Required
                  </label>
                  <RemoveButton
                    label={`Remove environment variable ${row.alias || index + 1}`}
                    onClick={() => commit({ ...access, env: access.env.filter((_, i) => i !== index) })}
                  />
                </div>
              ))}
            </div>
          ) : null}
          <div>
            <Button size="sm" icon={<LuPlus aria-hidden />} onClick={() => commit({ ...access, env: [...access.env, { alias: "", required: true, capabilityId: "" }] })}>
              Add variable
            </Button>
          </div>
        </div>
      </Field>
      <Field label="Network" hint="Calls go through the host: public https only. A credential reference lets the host add a stored credential; your code never sees the secret.">
        <div className="flex flex-col gap-2">
          {access.network.map((row, index) => (
            <div key={row.capabilityId || `api-${index}`} className="flex flex-col gap-2 rounded-lg border border-[var(--sf-hairline)] p-2.5">
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <TextBox
                    mono
                    ariaLabel={`API origin ${index + 1}`}
                    value={row.origin}
                    placeholder="https://api.example.com"
                    onChange={(origin) => commit({ ...access, network: access.network.map((item, i) => (i === index ? { ...item, origin } : item)) })}
                  />
                </div>
                <RemoveButton label={`Remove origin ${row.origin || index + 1}`} onClick={() => commit({ ...access, network: access.network.filter((_, i) => i !== index) })} />
              </div>
              <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                <SelectField
                  ariaLabel={`API effect ${index + 1}`}
                  value={row.effect}
                  options={effectChoices(kind, row.effect)}
                  onChange={(effect) => commit({ ...access, network: access.network.map((item, i) => (i === index ? { ...item, effect } : item)) })}
                />
                <TextBox
                  mono
                  ariaLabel={`API credential reference ${index + 1}`}
                  value={row.credentialRef ?? ""}
                  placeholder="Credential reference"
                  onChange={(raw) => {
                    const credentialRef = raw.trim();
                    commit({
                      ...access,
                      network: access.network.map((item, i) => {
                        if (i !== index) return item;
                        const next = { ...item };
                        if (credentialRef) next.credentialRef = credentialRef;
                        else delete next.credentialRef;
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
              onClick={() => commit({ ...access, network: [...access.network, { capabilityId: "", origin: "", effect: "read" }] })}
            >
              Add origin
            </Button>
          </div>
        </div>
      </Field>
      {access.advanced.length > 0 ? (
        <details
          open={advancedOpen}
          onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}
          className="rounded-lg border border-[var(--sf-hairline)] px-3 py-2"
        >
          <summary className="cursor-pointer text-xs font-medium leading-[1.33333] text-[var(--sf-text-2)]">Advanced access ({access.advanced.length})</summary>
          <div className="mt-3 flex flex-col gap-3">
            <CapabilityCards
              kind={kind}
              capabilities={access.advanced}
              onChange={(advanced) => commit({ ...access, advanced })}
            />
            <AdvancedAdd onAdd={addAdvanced} />
          </div>
        </details>
      ) : adderOpen ? (
        <AdvancedAdd onAdd={addAdvanced} />
      ) : (
        <button type="button" className="w-fit text-xs leading-[1.33333] text-[var(--sf-text-2)] underline" onClick={() => setAdderOpen(true)}>
          Add advanced access
        </button>
      )}
    </div>
  );
}

function AdvancedAdd({ onAdd }: { onAdd: (type: "file" | "api") => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {(["file", "api"] as const).map((type) => (
        <Button key={type} size="sm" icon={<LuPlus aria-hidden />} onClick={() => onAdd(type)}>
          {TYPE_META[type].add}
        </Button>
      ))}
    </div>
  );
}

function CapabilityCards({
  kind,
  capabilities,
  onChange,
}: {
  kind: FunctionKind;
  capabilities: FunctionCapability[];
  onChange: (next: FunctionCapability[]) => void;
}) {
  const tool = kind === "tool";

  function replace(index: number, next: FunctionCapability) {
    onChange(capabilities.map((capability, i) => (i === index ? next : capability)));
  }

  function changeType(index: number, type: FunctionCapability["type"]) {
    const current = capabilities[index];
    if (!current || current.type === type) return;
    const next = blank(type, capabilities.filter((_, i) => i !== index));
    replace(index, { ...next, id: current.id });
  }

  return (
    <div className="flex flex-col gap-2">
      {capabilities.map((capability, index) => (
        <div key={`${capability.id}-${index}`} className="flex flex-col gap-3 rounded-lg border border-[var(--sf-hairline)] p-3.5">
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-2 text-xs font-medium leading-[1.33333] text-[var(--sf-text-2)] [&>svg]:size-3.5">
              {TYPE_META[capability.type].icon}
              {TYPE_META[capability.type].label}
            </span>
            <RemoveButton label={`Remove capability ${capability.id}`} onClick={() => onChange(capabilities.filter((_, i) => i !== index))} />
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <Field label="Capability id" hint="Grants refer to it by this id.">
              <TextBox mono ariaLabel={`Capability ${index + 1} id`} value={capability.id} onChange={(id) => replace(index, { ...capability, id })} />
            </Field>
            <Field label="Type">
              <SelectField ariaLabel={`Capability ${index + 1} type`} value={capability.type} options={TYPE_OPTIONS} onChange={(type) => changeType(index, type)} />
            </Field>
            {capability.type === "file" ? <FileFields capability={capability} tool={tool} onChange={(next) => replace(index, next)} /> : null}
            {capability.type === "env" ? (
              <div className="md:col-span-2">
                <Field label="Alias" hint="The name your code reads the value under.">
                  <TextBox
                    mono
                    ariaLabel={`Capability ${index + 1} alias`}
                    value={capability.alias}
                    placeholder="FEED_REGION"
                    onChange={(alias) => replace(index, { ...capability, alias })}
                  />
                </Field>
              </div>
            ) : null}
            {capability.type === "api" ? <ApiFields capability={capability} tool={tool} onChange={(next) => replace(index, next)} /> : null}
          </div>
        </div>
      ))}
    </div>
  );
}

function FileFields({
  capability,
  tool,
  onChange,
}: {
  capability: FunctionFileCapability;
  tool: boolean;
  onChange: (next: FunctionFileCapability) => void;
}) {
  const access: Array<{ value: FunctionFileCapability["access"]; label: string }> = [{ value: "read", label: "Read" }];
  if (tool || capability.access === "write") access.push({ value: "write", label: "Write" });
  return (
    <>
      <Field label="Root" hint="Run artifacts, or the checked-out workspace.">
        <SelectField
          ariaLabel="File root"
          value={capability.root}
          options={[
            { value: "artifacts", label: "Artifacts" },
            { value: "workspace", label: "Workspace" },
          ]}
          onChange={(root) => onChange({ ...capability, root })}
        />
      </Field>
      <Field label="Path" hint="Relative to the root.">
        <TextBox mono ariaLabel="File path" value={capability.path} placeholder="reports/summary.md" onChange={(path) => onChange({ ...capability, path })} />
      </Field>
      <Field label="Access">
        <SelectField ariaLabel="File access" value={capability.access} options={access} onChange={(next) => onChange({ ...capability, access: next })} />
      </Field>
    </>
  );
}

function ApiFields({
  capability,
  tool,
  onChange,
}: {
  capability: FunctionApiCapability;
  tool: boolean;
  onChange: (next: FunctionApiCapability) => void;
}) {
  const effect: Array<{ value: FunctionApiCapability["effect"]; label: string }> = [{ value: "read", label: "Read (no side effects)" }];
  if (tool || capability.effect === "action") effect.push({ value: "action", label: "Action (changes something)" });
  return (
    <>
      <div className="md:col-span-2">
        <Field label="Origin" hint="A public https origin. Other hosts, and private or local addresses, are blocked.">
          <TextBox mono ariaLabel="API origin" value={capability.origin} placeholder="https://api.example.com" onChange={(origin) => onChange({ ...capability, origin })} />
        </Field>
      </div>
      <Field label="Methods" hint="Press Enter or comma to add.">
        <ChipListField
          ariaLabel="API methods"
          values={capability.methods}
          suggestions={HTTP_METHODS}
          placeholder="GET"
          onChange={(values) => onChange({ ...capability, methods: [...new Set(values.map((method) => method.toUpperCase()))] })}
        />
      </Field>
      <Field label="Path prefix">
        <TextBox mono ariaLabel="API path prefix" value={capability.path_prefix} placeholder="/v1" onChange={(path_prefix) => onChange({ ...capability, path_prefix })} />
      </Field>
      <Field label="Effect">
        <SelectField ariaLabel="API effect" value={capability.effect} options={effect} onChange={(next) => onChange({ ...capability, effect: next })} />
      </Field>
      <Field label="Credential reference" hint="Optional. The host adds this stored credential to the request. Your code never sees the secret.">
        <TextBox
          mono
          ariaLabel="API credential reference"
          value={capability.credential_ref ?? ""}
          onChange={(raw) => {
            const credential_ref = raw.trim();
            const next = { ...capability };
            if (credential_ref) next.credential_ref = credential_ref;
            else delete next.credential_ref;
            onChange(next);
          }}
        />
      </Field>
    </>
  );
}
