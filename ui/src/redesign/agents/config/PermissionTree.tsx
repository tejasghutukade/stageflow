import { useEffect, useRef } from "react";
import { LuChevronDown } from "react-icons/lu";
import { MONO } from "../agentsTokens";
import { groupState, setGroup, setTool, toolGranted, type Grants, type PermissionGroup } from "../model/permissions";
import { ListGroup } from "../ui";

function TriCheckbox({ state, onChange, label, disabled }: { state: "all" | "some" | "none"; onChange: (on: boolean) => void; label: string; disabled?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === "some";
  }, [state]);
  return (
    <input
      ref={ref}
      type="checkbox"
      aria-label={label}
      checked={state === "all"}
      disabled={disabled}
      onChange={(event) => onChange(event.target.checked)}
      className="size-4 shrink-0 accent-[var(--sf-text-1)]"
    />
  );
}

const RISK_STYLE = {
  write: "bg-[#f5b5441f] text-[var(--sf-needs)]",
  destructive: "bg-[var(--sf-fail-bg)] text-[var(--sf-fail)]",
  external: "bg-[#f5b5441f] text-[var(--sf-needs)]",
} as const;

/**
 * Grouped checkboxes: the group box selects every child, a child box selects
 * one, and a partly ticked group shows the mixed state.
 */
export function PermissionTree({
  groups,
  grants,
  onChange,
  openGroups,
  onToggleOpen,
  askFirst,
  askId = (toolId) => toolId,
  testId,
}: {
  groups: PermissionGroup[];
  grants: Grants;
  /** Absent in read-only views. */
  onChange?: (next: Grants, added: { groupId: string; toolIds: string[] }) => void;
  openGroups: string[];
  onToggleOpen: (groupId: string) => void;
  /** Tool ids (as stored in approvals.ask_first) that ask a person first. */
  askFirst: string[];
  askId?: (toolId: string) => string;
  testId?: string;
}) {
  return (
    <ListGroup>
      <div data-testid={testId} className="contents">
        {groups.map((group) => {
          const state = groupState(grants, group);
          const open = openGroups.includes(group.id);
          const granted = group.tools.filter((tool) => toolGranted(grants, group, tool.id)).length;
          return (
            <div key={group.id} className="flex flex-col">
              <div className="flex items-start gap-3 px-3.5 py-3">
                <span className="mt-0.5">
                  <TriCheckbox
                    state={state}
                    label={`${group.title} (all)`}
                    disabled={!onChange}
                    onChange={(on) => onChange?.(setGroup(grants, group, on), { groupId: group.id, toolIds: on ? group.tools.map((t) => t.id) : [] })}
                  />
                </span>
                <button type="button" aria-expanded={open} onClick={() => onToggleOpen(group.id)} className="flex min-w-0 flex-1 flex-col gap-0.5 text-left">
                  <span className="flex items-center gap-2">
                    <span className={`text-[13px] leading-normal ${state === "none" ? "text-[var(--sf-text-2)]" : "text-[var(--sf-text-1)]"}`}>{group.title}</span>
                    <span className={`${MONO} text-[11px] text-[var(--sf-text-3)]`}>{state === "all" ? `all ${group.tools.length}` : state === "some" ? `${granted} of ${group.tools.length}` : `${group.tools.length} tool${group.tools.length === 1 ? "" : "s"}`}</span>
                    <LuChevronDown aria-hidden className={`size-3 text-[var(--sf-text-3)] transition-transform ${open ? "rotate-180" : ""}`} />
                  </span>
                  <span className="text-xs leading-[1.33333] text-[var(--sf-text-3)]">{group.summary}</span>
                </button>
              </div>
              {open ? (
                <div className="flex flex-col gap-2 border-t border-t-[var(--sf-hairline)] bg-[var(--sf-panel)] py-2.5 pl-[42px] pr-3.5">
                  {group.tools.map((tool) => {
                    const on = toolGranted(grants, group, tool.id);
                    const asks = askFirst.includes(askId(tool.id));
                    return (
                      <label key={tool.id} className="flex items-start gap-2.5">
                        <span className="mt-0.5">
                          <TriCheckbox
                            state={on ? "all" : "none"}
                            label={`Allow ${tool.label}`}
                            disabled={!onChange}
                            onChange={(next) => onChange?.(setTool(grants, group, tool.id, next), { groupId: group.id, toolIds: next ? [tool.id] : [] })}
                          />
                        </span>
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="flex flex-wrap items-center gap-2">
                            <span className={`${MONO} text-xs ${on ? "text-[var(--sf-text-1)]" : "text-[var(--sf-text-2)]"}`}>{tool.label}</span>
                            {tool.risk !== "read" ? <span className={`rounded-md px-1 text-[10px] ${RISK_STYLE[tool.risk]}`}>{tool.risk}</span> : null}
                            {on && asks ? <span className="rounded-md bg-[#f5b5441f] px-1 text-[10px] text-[var(--sf-needs)]">asks first</span> : null}
                          </span>
                          <span className="line-clamp-2 text-[11px] leading-normal text-[var(--sf-text-3)]">{tool.description}</span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </ListGroup>
  );
}
