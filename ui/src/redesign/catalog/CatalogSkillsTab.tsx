import { useCallback, useEffect, useMemo, useState } from "react";
import {
  fetchSkills,
  fetchSkillUsage,
  type SkillListing,
  type SkillUsageIndex,
} from "../../api";
import { catalogPath } from "../../routes";
import { navigate } from "../../routes";

export type SkillScopeFilter = "all" | SkillListing["scope"];

export function CatalogSkillsTab({ skillName }: { skillName?: string }) {
  const [skills, setSkills] = useState<SkillListing[]>([]);
  const [usage, setUsage] = useState<SkillUsageIndex | null>(null);
  const [scope, setScope] = useState<SkillScopeFilter>("all");
  const [selectedName, setSelectedName] = useState<string | null>(
    skillName ?? null,
  );
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const result = await fetchSkills();
      setSkills(result.skills);
      setError(null);
      try {
        const u = await fetchSkillUsage();
        setUsage(u);
      } catch {
        setUsage(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (skillName) setSelectedName(skillName);
  }, [skillName]);

  const filtered = useMemo(() => {
    if (scope === "all") return skills;
    return skills.filter((s) => s.scope === scope);
  }, [skills, scope]);

  const selected = useMemo(
    () => filtered.find((s) => s.name === selectedName) ?? null,
    [filtered, selectedName],
  );

  useEffect(() => {
    if (filtered.length === 0) {
      setSelectedName(null);
      return;
    }
    if (!selectedName || !filtered.some((s) => s.name === selectedName)) {
      setSelectedName(filtered[0]!.name);
    }
  }, [filtered, selectedName]);

  const usageEntry = selected && usage ? usage.usages[selected.name] : undefined;

  function selectSkill(name: string) {
    setSelectedName(name);
    navigate(catalogPath({ tab: "skills", skill: name }));
  }

  const scopeTabs: { id: SkillScopeFilter; label: string }[] = [
    { id: "all", label: "All" },
    { id: "project", label: "Project" },
    { id: "user", label: "User" },
    { id: "temporary", label: "Temporary" },
  ];

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
        <div className="flex h-12 shrink-0 items-center gap-0.5 border-b border-b-[#ffffff12] px-4">
          {scopeTabs.map((t) => {
            const active = scope === t.id;
            const count =
              t.id === "all"
                ? skills.length
                : skills.filter((s) => s.scope === t.id).length;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setScope(t.id)}
                className={`flex h-7 items-center gap-1.5 rounded-md px-2.5 py-0 text-[13px]${
                  active
                    ? " border border-[#ffffff1a] bg-[var(--sf-raised)] font-medium text-[var(--sf-text-1)]"
                    : " text-[var(--sf-text-2)]"
                }`}
              >
                <span>{t.label}</span>
                <span className="font-['Geist_Mono',monospace] text-xs text-[var(--sf-text-2)]">
                  {count}
                </span>
              </button>
            );
          })}
        </div>
        {error ? (
          <p className="px-4 py-3 text-xs text-[var(--sf-fail)]">{error}</p>
        ) : null}
        {loading ? (
          <p className="px-4 py-3 text-xs text-[var(--sf-text-3)]">
            Loading skills…
          </p>
        ) : null}
        {!loading && filtered.length === 0 ? (
          <p className="px-4 py-3 text-xs text-[var(--sf-text-3)]">
            No skills in this scope.
          </p>
        ) : null}
        <div className="flex h-8 shrink-0 items-center gap-2.5 border-b border-b-[#ffffff12] px-4 py-0">
          <div className="min-w-0 flex-1 text-[11px] font-medium uppercase tracking-[0.88px] text-[var(--sf-text-3)]">
            Skill
          </div>
          <div className="w-[88px] shrink-0 text-[11px] font-medium uppercase tracking-[0.88px] text-[var(--sf-text-3)]">
            Scope
          </div>
          <div className="w-[108px] shrink-0 text-[11px] font-medium uppercase tracking-[0.88px] text-[var(--sf-text-3)]">
            Invocation
          </div>
          <div className="w-[172px] shrink-0 text-[11px] font-medium uppercase tracking-[0.88px] text-[var(--sf-text-3)]">
            Source
          </div>
        </div>
        {filtered.map((skill) => {
          const selectedRow = selectedName === skill.name;
          return (
            <button
              key={`${skill.scope}:${skill.filePath}`}
              type="button"
              onClick={() => selectSkill(skill.name)}
              className={`flex h-12 w-full shrink-0 items-center gap-2.5 border-b border-b-[#ffffff12] py-0 pl-3.5 pr-4 text-left${
                selectedRow
                  ? " border-l-2 border-l-[var(--sf-text-1)] bg-[var(--sf-panel)]"
                  : " border-l-2 border-l-transparent hover:bg-[var(--sf-raised)]"
              }`}
            >
              <div className="flex min-w-0 flex-1 flex-col gap-0.5 overflow-hidden">
                <span className="truncate font-['Geist_Mono',monospace] text-[13px] font-medium text-[var(--sf-text-1)]">
                  {skill.name}
                </span>
                <span
                  className="truncate text-xs text-[var(--sf-text-3)]"
                  title={skill.description}
                >
                  {skill.description}
                </span>
              </div>
              <div className="w-[88px] shrink-0 font-['Geist_Mono',monospace] text-[11px] text-[var(--sf-text-2)]">
                {skill.scope}
              </div>
              <div className="w-[108px] shrink-0 font-['Geist_Mono',monospace] text-[11px] text-[var(--sf-text-2)]">
                {skill.disableModelInvocation ? "command-only" : "model"}
              </div>
              <div
                className="w-[172px] shrink-0 truncate font-['Geist_Mono',monospace] text-[11px] text-[var(--sf-text-2)]"
                title={skill.source}
              >
                {skill.source}
              </div>
            </button>
          );
        })}
      </div>
      {selected ? (
        <aside className="flex w-96 shrink-0 flex-col border-l border-l-[#ffffff12] bg-[var(--sf-panel)]">
          <div className="shrink-0 border-b border-b-[#ffffff12] px-4 py-3 text-sm font-semibold text-[var(--sf-text-1)]">
            {selected.name}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 text-xs">
            <p className="text-[13px] text-[var(--sf-text-2)]">
              {selected.description}
            </p>
            <dl className="mt-3 grid gap-2">
              <dt className="text-[var(--sf-text-3)]">Scope</dt>
              <dd className="font-['Geist_Mono',monospace]">{selected.scope}</dd>
              <dt className="text-[var(--sf-text-3)]">Source</dt>
              <dd className="font-['Geist_Mono',monospace]">{selected.source}</dd>
              <dt className="text-[var(--sf-text-3)]">Invocation</dt>
              <dd className="font-['Geist_Mono',monospace]">
                {selected.disableModelInvocation ? "command-only" : "model"}
              </dd>
              <dt className="text-[var(--sf-text-3)]">File</dt>
              <dd className="font-['Geist_Mono',monospace]">{selected.filePath}</dd>
              <dt className="text-[var(--sf-text-3)]">Base dir</dt>
              <dd className="font-['Geist_Mono',monospace]">{selected.baseDir}</dd>
            </dl>
            {usageEntry ? (
              <>
                <h4 className="mt-4 text-[11px] font-medium uppercase tracking-[0.88px] text-[var(--sf-text-3)]">
                  Used by
                </h4>
                <p className="text-[var(--sf-text-3)]">
                  {usageEntry.stage_ids.length} stage
                  {usageEntry.stage_ids.length === 1 ? "" : "s"} across{" "}
                  {usageEntry.pipeline_ids.length} pipeline
                  {usageEntry.pipeline_ids.length === 1 ? "" : "s"}
                </p>
                {usageEntry.stage_ids.length > 0 ? (
                  <ul className="mt-1 list-inside list-disc font-['Geist_Mono',monospace] text-[var(--sf-text-2)]">
                    {usageEntry.stage_ids.map((id) => (
                      <li key={id}>{id}</li>
                    ))}
                  </ul>
                ) : null}
              </>
            ) : null}
          </div>
        </aside>
      ) : null}
    </div>
  );
}
