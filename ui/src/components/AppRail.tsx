import { StageflowIcon } from "./StageflowIcon";

export type RailItem = {
  id: string;
  label: string;
  glyph: string;
};

export type AppRailProps = {
  activeId: string;
  onNavigate: (id: string) => void;
  waitingCount?: number;
  health?: { activeCount: number; maxConcurrent: number; slotsAvailable: number; activeRunIds: string[] } | null;
};

const defaultItems: RailItem[] = [
  { id: "today", label: "Today", glyph: "◉" },
  { id: "runs", label: "Runs", glyph: "▤" },
  { id: "pipelines", label: "Pipelines", glyph: "⛓" },
  { id: "tasks", label: "Tasks", glyph: "▦" },
  { id: "skills", label: "Skills", glyph: "✦" },
  { id: "extensions", label: "Extensions", glyph: "◇" },
  { id: "settings", label: "Settings", glyph: "⚙" },
];

export { defaultItems as defaultRailItems };

export function AppRail({
  activeId,
  onNavigate,
  waitingCount,
  health,
}: AppRailProps) {
  return (
    <nav className="rail">
      <a
        className="rail__brand"
        href="#/today"
        onClick={(e) => {
          e.preventDefault();
          onNavigate("today");
        }}
      >
        <span className="rail__mark" aria-hidden="true">
          <StageflowIcon size={28} />
        </span>
        <span>Stageflow</span>
      </a>

      <div className="rail__new">
        <a
          className="btn btn--primary"
          href="#/new"
          style={{ width: "100%" }}
          onClick={(e) => {
            e.preventDefault();
            onNavigate("new");
          }}
        >
          Start a run
        </a>
      </div>

      {defaultItems.map((item) => (
        <a
          key={item.id}
          className="rail__item"
          href={`#/${item.id}`}
          aria-current={activeId === item.id ? "page" : undefined}
          onClick={(e) => {
            e.preventDefault();
            onNavigate(item.id);
          }}
        >
          <span className="rail__glyph" aria-hidden="true">{item.glyph}</span>
          <span className="rail__label">{item.label}</span>
          {item.id === "today" && waitingCount != null && waitingCount > 0 && (
            <span className="rail__count">{waitingCount}</span>
          )}
        </a>
      ))}

      <div className="rail__foot">
        <div className="eyebrow">Capacity</div>
        {health ? (
          <>
            <div className="capacity" aria-hidden="true">
              {Array.from({ length: health.maxConcurrent }, (_, i) => (
                <i key={i} {...(i < health.activeCount ? { "data-used": "true" } : {})} />
              ))}
            </div>
            <div className="mono muted" style={{ fontSize: "var(--font-size-xs)" }}>
              {health.activeCount} of {health.maxConcurrent} slots · {health.slotsAvailable === 0 ? "none free" : `${health.slotsAvailable} free`}
            </div>
          </>
        ) : (
          <div className="mono muted" style={{ fontSize: "var(--font-size-xs)" }}>—</div>
        )}
      </div>
    </nav>
  );
}
