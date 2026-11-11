import type { FunctionApiCapability, FunctionBinding, FunctionCapability, FunctionFileCapability, FunctionKind } from "../../api/functions";

const FIELD =
  "flex h-8 w-full rounded-lg border border-[var(--sf-hairline-strong)] bg-[var(--sf-panel)] px-2.5 text-[13px] text-[var(--sf-text-1)] outline-none";

function nextId(prefix: string, capabilities: readonly FunctionCapability[]): string {
  const taken = new Set(capabilities.map((capability) => capability.id));
  let n = capabilities.length + 1;
  while (taken.has(`${prefix}_${n}`)) n += 1;
  return `${prefix}_${n}`;
}

function blank(kind: FunctionCapability["type"], capabilities: readonly FunctionCapability[]): FunctionCapability {
  if (kind === "env") return { id: nextId("env", capabilities), type: "env", alias: "" };
  if (kind === "api") {
    return {
      id: nextId("api", capabilities),
      type: "api",
      origin: "https://example.com",
      methods: ["GET"],
      path_prefix: "/",
      effect: "read",
    };
  }
  return { id: nextId("file", capabilities), type: "file", root: "artifacts", path: "", access: "read" };
}

export function FunctionContractFields({
  kind,
  capabilities,
  bindings,
  onCapabilities,
  onBindings,
}: {
  kind: FunctionKind;
  capabilities: FunctionCapability[];
  bindings: FunctionBinding[];
  onCapabilities: (next: FunctionCapability[]) => void;
  onBindings: (next: FunctionBinding[]) => void;
}) {
  const tool = kind === "tool";

  function replace(index: number, next: FunctionCapability) {
    onCapabilities(capabilities.map((capability, i) => (i === index ? next : capability)));
  }

  function changeType(index: number, type: FunctionCapability["type"]) {
    const current = capabilities[index];
    if (!current || current.type === type) return;
    const next = blank(type, capabilities.filter((_, i) => i !== index));
    replace(index, { ...next, id: current.id });
  }

  return (
    <section className="flex flex-col gap-3" data-testid="function-contract">
      <div className="flex flex-col gap-1">
        <h2 className="text-[13px] font-medium text-[var(--sf-text-1)]">Capabilities and bindings</h2>
        <p className="text-xs leading-normal text-[var(--sf-text-3)]">
          A file capability names artifacts or workspace, a relative path, and read or write. An env capability names an alias. An API capability names an https origin, methods, a path prefix, and read or action. Only a tool can write a file or call an action. A binding aliases an env capability and says whether that value is required. An attachment must grant each capability or validation reports it as under-granted.
        </p>
      </div>
      {capabilities.map((capability, index) => (
        <div key={`${capability.type}-${index}`} className="grid grid-cols-1 gap-2 rounded-lg border border-[var(--sf-hairline)] p-3 md:grid-cols-2">
          <label className="flex flex-col gap-1 text-xs text-[var(--sf-text-3)]">
            Capability id
            <input
              aria-label={`Capability ${index + 1} id`}
              className={FIELD}
              value={capability.id}
              onChange={(event) => replace(index, { ...capability, id: event.target.value })}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-[var(--sf-text-3)]">
            Type
            <select
              aria-label={`Capability ${index + 1} type`}
              className={FIELD}
              value={capability.type}
              onChange={(event) => changeType(index, event.target.value as FunctionCapability["type"])}
            >
              <option value="file">file</option>
              <option value="env">env</option>
              <option value="api">api</option>
            </select>
          </label>
          {capability.type === "file" ? (
            <FileFields capability={capability} tool={tool} onChange={(next) => replace(index, next)} />
          ) : null}
          {capability.type === "env" ? (
            <label className="flex flex-col gap-1 text-xs text-[var(--sf-text-3)] md:col-span-2">
              Alias
              <input
                aria-label={`Capability ${index + 1} alias`}
                className={FIELD}
                value={capability.alias}
                onChange={(event) => replace(index, { ...capability, alias: event.target.value })}
              />
            </label>
          ) : null}
          {capability.type === "api" ? <ApiFields capability={capability} tool={tool} onChange={(next) => replace(index, next)} /> : null}
          <div className="md:col-span-2">
            <button type="button" className="text-xs text-[var(--sf-text-2)]" onClick={() => onCapabilities(capabilities.filter((_, i) => i !== index))}>
              Remove capability
            </button>
          </div>
        </div>
      ))}
      <div className="flex flex-wrap gap-2">
        {(["file", "env", "api"] as const).map((type) => (
          <button
            key={type}
            type="button"
            className="rounded-lg border border-[var(--sf-hairline-strong)] px-2.5 py-1 text-xs text-[var(--sf-text-1)]"
            onClick={() => onCapabilities([...capabilities, blank(type, capabilities)])}
          >
            Add {type}
          </button>
        ))}
      </div>
      {bindings.map((binding, index) => (
        <div key={`binding-${index}`} className="grid grid-cols-1 gap-2 md:grid-cols-[1fr_160px_auto]">
          <label className="flex flex-col gap-1 text-xs text-[var(--sf-text-3)]">
            Binding alias
            <input
              aria-label={`Binding ${index + 1} alias`}
              className={FIELD}
              value={binding.alias}
              onChange={(event) =>
                onBindings(bindings.map((item, i) => (i === index ? { ...item, alias: event.target.value } : item)))
              }
            />
          </label>
          <label className="flex items-end gap-2 pb-2 text-xs text-[var(--sf-text-2)]">
            <input
              aria-label={`Binding ${index + 1} required`}
              type="checkbox"
              checked={binding.required}
              onChange={(event) =>
                onBindings(bindings.map((item, i) => (i === index ? { ...item, required: event.target.checked } : item)))
              }
            />
            Required
          </label>
          <button type="button" className="self-end pb-2 text-xs text-[var(--sf-text-2)]" onClick={() => onBindings(bindings.filter((_, i) => i !== index))}>
            Remove binding
          </button>
        </div>
      ))}
      <div>
        <button
          type="button"
          className="rounded-lg border border-[var(--sf-hairline-strong)] px-2.5 py-1 text-xs text-[var(--sf-text-1)]"
          onClick={() => onBindings([...bindings, { alias: "", required: true }])}
        >
          Add binding
        </button>
      </div>
    </section>
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
  return (
    <>
      <label className="flex flex-col gap-1 text-xs text-[var(--sf-text-3)]">
        Root
        <select aria-label="File root" className={FIELD} value={capability.root} onChange={(event) => onChange({ ...capability, root: event.target.value as FunctionFileCapability["root"] })}>
          <option value="artifacts">artifacts</option>
          <option value="workspace">workspace</option>
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs text-[var(--sf-text-3)]">
        Path
        <input aria-label="File path" className={FIELD} value={capability.path} onChange={(event) => onChange({ ...capability, path: event.target.value })} />
      </label>
      <label className="flex flex-col gap-1 text-xs text-[var(--sf-text-3)]">
        Access
        <select
          aria-label="File access"
          className={FIELD}
          value={capability.access}
          onChange={(event) => onChange({ ...capability, access: event.target.value as FunctionFileCapability["access"] })}
        >
          <option value="read">read</option>
          {tool || capability.access === "write" ? <option value="write">write</option> : null}
        </select>
      </label>
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
  return (
    <>
      <label className="flex flex-col gap-1 text-xs text-[var(--sf-text-3)] md:col-span-2">
        Origin
        <input aria-label="API origin" className={FIELD} value={capability.origin} onChange={(event) => onChange({ ...capability, origin: event.target.value })} />
      </label>
      <label className="flex flex-col gap-1 text-xs text-[var(--sf-text-3)]">
        Methods
        <input
          aria-label="API methods"
          className={FIELD}
          value={capability.methods.join(", ")}
          onChange={(event) =>
            onChange({
              ...capability,
              methods: event.target.value
                .split(",")
                .map((method) => method.trim())
                .filter((method) => method.length > 0),
            })
          }
        />
      </label>
      <label className="flex flex-col gap-1 text-xs text-[var(--sf-text-3)]">
        Path prefix
        <input aria-label="API path prefix" className={FIELD} value={capability.path_prefix} onChange={(event) => onChange({ ...capability, path_prefix: event.target.value })} />
      </label>
      <label className="flex flex-col gap-1 text-xs text-[var(--sf-text-3)]">
        Effect
        <select
          aria-label="API effect"
          className={FIELD}
          value={capability.effect}
          onChange={(event) => onChange({ ...capability, effect: event.target.value as FunctionApiCapability["effect"] })}
        >
          <option value="read">read</option>
          {tool || capability.effect === "action" ? <option value="action">action</option> : null}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs text-[var(--sf-text-3)]">
        Credential reference
        <input
          aria-label="API credential reference"
          className={FIELD}
          value={capability.credential_ref ?? ""}
          onChange={(event) => {
            const credential_ref = event.target.value.trim();
            const next = { ...capability };
            if (credential_ref) next.credential_ref = credential_ref;
            else delete next.credential_ref;
            onChange(next);
          }}
        />
      </label>
    </>
  );
}
