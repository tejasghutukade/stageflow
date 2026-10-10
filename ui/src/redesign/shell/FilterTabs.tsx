export type FilterTab = {
  id: string;
  label: string;
  count?: number;
};

export type FilterTabsProps = {
  tabs: FilterTab[];
  activeId: string;
  onChange: (id: string) => void;
  variant?: "bar" | "underline" | "queue";
};

function tabCountClass(active: boolean): string {
  return active
    ? "bg-[var(--sf-raised)] text-[var(--sf-text-2)]"
    : "bg-[var(--sf-raised)] text-[var(--sf-text-3)]";
}

export function FilterTabs({
  tabs,
  activeId,
  onChange,
  variant = "bar",
}: FilterTabsProps) {
  if (variant === "underline") {
    return (
      <div
        className="flex h-10 w-full shrink-0 items-end gap-5 border-b border-b-[#ffffff12] px-7"
        role="tablist"
      >
        {tabs.map((tab) => {
          const active = tab.id === activeId;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={active}
              className={`flex h-full items-center gap-1.5 border-b-2 pb-0 pt-0${
                active
                  ? " border-b-[var(--sf-text-1)]"
                  : " border-b-transparent"
              }`}
              onClick={() => onChange(tab.id)}
            >
              <span
                className={`text-[13px]${
                  active
                    ? " font-medium text-[var(--sf-text-1)]"
                    : " text-[var(--sf-text-2)]"
                }`}
              >
                {tab.label}
              </span>
              {tab.count != null ? (
                <span
                  className={`rounded-sm px-[5px] py-0 font-['Geist_Mono',monospace] text-[11px] ${tabCountClass(active)}`}
                >
                  {tab.count}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    );
  }

  if (variant === "queue") {
    return (
      <div className="flex gap-5" role="tablist">
        {tabs.map((tab) => {
          const active = tab.id === activeId;
          const needsYou = tab.id === "needs";
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={active}
              className={`flex items-center gap-1.5 border-b-2 pb-2.5 pt-0${
                active && needsYou
                  ? " border-b-[var(--sf-needs)]"
                  : active
                    ? " border-b-[var(--sf-text-1)]"
                    : " border-b-transparent"
              }`}
              onClick={() => onChange(tab.id)}
            >
              <span
                className={`text-[13px]${
                  active
                    ? " font-medium text-[var(--sf-text-1)]"
                    : " text-[var(--sf-text-2)]"
                }`}
              >
                {tab.label}
              </span>
              {tab.count != null ? (
                <span
                  className={`rounded-sm px-[5px] py-0 font-['Geist_Mono',monospace] text-[11px] ${tabCountClass(active)}`}
                >
                  {tab.count}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div
      className="flex h-12 w-full shrink-0 items-center gap-0.5 border-b border-b-[#ffffff12] px-5"
      role="tablist"
    >
      {tabs.map((tab) => {
        const active = tab.id === activeId;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={active}
            className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[13px]${
              active
                ? " bg-[var(--sf-raised)] font-medium text-[var(--sf-text-1)]"
                : " text-[var(--sf-text-2)]"
            }`}
            onClick={() => onChange(tab.id)}
          >
            <span>{tab.label}</span>
            {tab.count != null ? (
              <span
                className={`rounded-sm px-[5px] py-0 font-['Geist_Mono',monospace] text-[11px] ${tabCountClass(active)}`}
              >
                {tab.count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
