import { LuCheck, LuTriangleAlert } from "react-icons/lu";
import type { IdentityScope } from "../../api/identity";
import { INPUT, MONO, Tag } from "./identityParts";
import { IDENTITY_SCOPES, SCOPE_INFO, splitResourceList, type AgentOption } from "./identityView";

export function ScopePicker({
  value,
  onChange,
  resources,
  onResources,
  name,
}: {
  value: IdentityScope;
  onChange: (scope: IdentityScope) => void;
  resources: string;
  onResources: (value: string) => void;
  name: string;
}) {
  const listed = splitResourceList(resources);
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1.5 text-[13px] font-medium text-[#ecedee]">What can they see?</legend>
      <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Access level">
        {IDENTITY_SCOPES.map((scope) => {
          const info = SCOPE_INFO[scope];
          const active = scope === value;
          return (
            <label
              key={scope}
              className={`flex cursor-pointer flex-col gap-1 rounded-lg border px-3 py-2.5 ${active ? "border-[#6ca6ff] bg-[#6ca6ff14]" : "border-[#ffffff1a] bg-[#1a1c21] hover:border-[#ffffff33]"}`}
            >
              <input
                type="radio"
                name={name}
                value={scope}
                checked={active}
                onChange={() => onChange(scope)}
                className="sr-only"
              />
              <span className="flex items-center justify-between gap-2">
                <span className="text-[13px] font-medium text-[#ecedee]">{info.label}</span>
                {active ? <LuCheck className="block size-3.5 text-[#6ca6ff]" aria-hidden /> : null}
              </span>
              <span className="text-xs leading-[1.45] text-[#a7aab2]">{info.summary}</span>
              <span className="text-xs leading-[1.45] text-[#8b8f98]">{info.example}</span>
            </label>
          );
        })}
      </div>
      {value === "workspace" ? (
        <div className="flex items-start gap-2 rounded-lg border border-[#f5b54447] bg-[#f5b5441a] px-3 py-2 text-xs leading-[1.5] text-[#f5b544]">
          <LuTriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          Broad access. Use it only for people who should see every order in this workspace.
        </div>
      ) : null}
      {value === "selected" ? (
        <div className="flex flex-col gap-1.5">
          <label className="flex flex-col gap-1.5">
            <span className="text-[13px] font-medium text-[#ecedee]">Order ids</span>
            <input
              className={`${INPUT} ${MONO}`}
              value={resources}
              placeholder="ord_1001, ord_1002"
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => onResources(event.target.value)}
            />
          </label>
          {listed.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {listed.map((id) => <Tag key={id} mono>{id}</Tag>)}
            </div>
          ) : (
            <span className="text-xs text-[#8b8f98]">Separate ids with commas or spaces.</span>
          )}
        </div>
      ) : null}
    </fieldset>
  );
}

export function AgentChips({
  agents,
  selected,
  onChange,
  multiple = true,
}: {
  agents: readonly AgentOption[];
  selected: readonly string[];
  onChange: (next: string[]) => void;
  multiple?: boolean;
}) {
  if (agents.length === 0) {
    return (
      <input
        className={`${INPUT} ${MONO}`}
        value={selected.join(", ")}
        placeholder="support"
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => onChange(splitResourceList(event.target.value))}
      />
    );
  }
  return (
    <div className="flex flex-wrap gap-2" role="group" aria-label="Agents">
      {agents.map((agent) => {
        const active = selected.includes(agent.id);
        return (
          <button
            key={agent.id}
            type="button"
            aria-pressed={active}
            title={agent.name}
            onClick={() => {
              if (!multiple) onChange([agent.id]);
              else onChange(active ? selected.filter((id) => id !== agent.id) : [...selected, agent.id]);
            }}
            className={`inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[13px] ${active ? "border-[#6ca6ff] bg-[#6ca6ff14] text-[#ecedee]" : "border-[#ffffff1a] bg-[#1a1c21] text-[#a7aab2] hover:bg-[#22252b]"}`}
          >
            {active ? <LuCheck className="block size-3 text-[#6ca6ff]" aria-hidden /> : null}
            <span className={MONO}>{agent.id}</span>
          </button>
        );
      })}
    </div>
  );
}
