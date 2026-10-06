import { useCallback, useEffect, useState } from "react";
import {
  fetchExtensions,
  fetchPipelines,
  fetchSkills,
  type ExtensionFileListing,
  type PackageListing,
} from "../api";
import { extensionFilePath, extensionPackagePath } from "../routes";
import { ExtensionsPage } from "./ExtensionsPage";
import { CatalogHeaderBar } from "../redesign/catalog/CatalogHeaderBar";
import { CatalogStagesTab } from "../redesign/catalog/CatalogStagesTab";
import { CatalogSkillsTab } from "../redesign/catalog/CatalogSkillsTab";
import type { CatalogTabId } from "../redesign/catalog/CatalogTabs";

export function CatalogPage({
  tab = "stages",
  skillName,
  packageScope,
  packageSource,
  filePath,
}: {
  tab?: CatalogTabId;
  skillName?: string;
  packageScope?: "user" | "project";
  packageSource?: string;
  filePath?: string;
}) {
  if (packageScope && packageSource) {
    return (
      <ExtensionsPage
        packageScope={packageScope}
        packageSource={packageSource}
      />
    );
  }
  if (filePath) {
    return <ExtensionsPage filePath={filePath} />;
  }

  return (
    <CatalogPageMain tab={tab} skillName={skillName} />
  );
}

function CatalogPageMain({
  tab,
  skillName,
}: {
  tab: CatalogTabId;
  skillName?: string;
}) {
  const [stageCount, setStageCount] = useState<number>();
  const [skillCount, setSkillCount] = useState<number>();
  const [extensionCount, setExtensionCount] = useState<number>();

  const loadCounts = useCallback(async () => {
    try {
      const [pipelines, skills, extensions] = await Promise.all([
        fetchPipelines(),
        fetchSkills(),
        fetchExtensions(),
      ]);
      const stageIds = new Set<string>();
      for (const pipeline of pipelines.pipelines) {
        for (const stage of pipeline.stages) {
          stageIds.add(`${pipeline.project_root ?? ""}:${stage.id}`);
        }
      }
      setStageCount(stageIds.size);
      setSkillCount(skills.skills.length);
      setExtensionCount(
        extensions.packages.length + extensions.extensions.length,
      );
    } catch {
      setStageCount(undefined);
      setSkillCount(undefined);
      setExtensionCount(undefined);
    }
  }, []);

  useEffect(() => {
    void loadCounts();
  }, [loadCounts]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--sf-ground)]">
      <CatalogHeaderBar
        active={tab}
        stageCount={stageCount}
        skillCount={skillCount}
        extensionCount={extensionCount}
      />
      <div className="flex min-h-0 flex-1 flex-col">
        {tab === "stages" ? <CatalogStagesTab /> : null}
        {tab === "skills" ? (
          <CatalogSkillsTab skillName={skillName} />
        ) : null}
        {tab === "extensions" ? <CatalogExtensionsTab /> : null}
      </div>
    </div>
  );
}

function CatalogExtensionsTab() {
  const [packages, setPackages] = useState<PackageListing[]>([]);
  const [extensions, setExtensions] = useState<ExtensionFileListing[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const result = await fetchExtensions();
      setPackages(result.packages);
      setExtensions(result.extensions);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const empty = !loading && packages.length === 0 && extensions.length === 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      {error ? (
        <p className="px-4 py-3 text-xs text-[var(--sf-fail)]">{error}</p>
      ) : null}
      {loading ? (
        <p className="px-4 py-3 text-xs text-[var(--sf-text-3)]">
          Loading extensions…
        </p>
      ) : null}
      {empty ? (
        <p className="px-4 py-3 text-xs text-[var(--sf-text-3)]">
          No extensions found under ~/.pi/agent/extensions, this project&apos;s
          .pi/extensions, or packages in Pi settings.
        </p>
      ) : null}
      {!loading && packages.length > 0 ? (
        <>
          <div className="flex h-8 shrink-0 items-center border-b border-b-[#ffffff12] px-4 text-[13px] font-semibold text-[var(--sf-text-1)]">
            Packages
          </div>
          <div className="flex h-8 shrink-0 items-center gap-2.5 border-b border-b-[#ffffff12] px-4 py-0">
            <div className="min-w-0 flex-1 text-[11px] font-medium uppercase tracking-[0.88px] text-[var(--sf-text-3)]">
              Source
            </div>
            <div className="w-[88px] shrink-0 text-[11px] font-medium uppercase tracking-[0.88px] text-[var(--sf-text-3)]">
              Scope
            </div>
            <div className="w-[172px] shrink-0 text-[11px] font-medium uppercase tracking-[0.88px] text-[var(--sf-text-3)]">
              Installed
            </div>
          </div>
          {packages.map((pkg) => (
            <div
              key={`${pkg.scope}:${pkg.source}`}
              className="flex h-10 shrink-0 items-center gap-2.5 border-b border-b-[#ffffff12] px-4 py-0"
            >
              <div className="min-w-0 flex-1 truncate font-['Geist_Mono',monospace] text-[13px]">
                <a href={`#${extensionPackagePath(pkg.scope, pkg.source)}`}>
                  {pkg.source}
                </a>
              </div>
              <div className="w-[88px] shrink-0 font-['Geist_Mono',monospace] text-[11px] text-[var(--sf-text-2)]">
                {pkg.scope}
              </div>
              <div
                className="w-[172px] shrink-0 truncate font-['Geist_Mono',monospace] text-[11px] text-[var(--sf-text-2)]"
                title={pkg.installedPath ?? undefined}
              >
                {pkg.installedPath ?? "not installed"}
              </div>
            </div>
          ))}
        </>
      ) : null}
      {!loading && extensions.length > 0 ? (
        <>
          <div className="flex h-8 shrink-0 items-center border-b border-b-[#ffffff12] px-4 text-[13px] font-semibold text-[var(--sf-text-1)]">
            Files
          </div>
          <div className="flex h-8 shrink-0 items-center gap-2.5 border-b border-b-[#ffffff12] px-4 py-0">
            <div className="min-w-0 flex-1 text-[11px] font-medium uppercase tracking-[0.88px] text-[var(--sf-text-3)]">
              Name
            </div>
            <div className="w-[88px] shrink-0 text-[11px] font-medium uppercase tracking-[0.88px] text-[var(--sf-text-3)]">
              Scope
            </div>
            <div className="w-[108px] shrink-0 text-[11px] font-medium uppercase tracking-[0.88px] text-[var(--sf-text-3)]">
              Source
            </div>
            <div className="w-[88px] shrink-0 text-[11px] font-medium uppercase tracking-[0.88px] text-[var(--sf-text-3)]">
              Origin
            </div>
          </div>
          {extensions.map((ext) => (
            <div
              key={`${ext.scope}:${ext.path}`}
              className="flex h-10 shrink-0 items-center gap-2.5 border-b border-b-[#ffffff12] px-4 py-0"
            >
              <div className="min-w-0 flex-1 truncate font-['Geist_Mono',monospace] text-[13px]">
                <a href={`#${extensionFilePath(ext.path)}`}>{ext.name}</a>
              </div>
              <div className="w-[88px] shrink-0 font-['Geist_Mono',monospace] text-[11px] text-[var(--sf-text-2)]">
                {ext.scope}
              </div>
              <div className="w-[108px] shrink-0 truncate font-['Geist_Mono',monospace] text-[11px] text-[var(--sf-text-2)]">
                {ext.source}
              </div>
              <div className="w-[88px] shrink-0 font-['Geist_Mono',monospace] text-[11px] text-[var(--sf-text-2)]">
                {ext.origin}
              </div>
            </div>
          ))}
        </>
      ) : null}
    </div>
  );
}
