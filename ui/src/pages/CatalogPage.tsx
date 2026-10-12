import { useCallback, useEffect, useRef, useState } from "react";
import { fetchPipelines, fetchSkills } from "../api";
import { ExtensionsPage } from "./ExtensionsPage";
import { CatalogHeaderBar } from "../redesign/catalog/CatalogHeaderBar";
import { CatalogStagesTab } from "../redesign/catalog/CatalogStagesTab";
import { CatalogSkillsTab } from "../redesign/catalog/CatalogSkillsTab";
import type { CatalogTabId } from "../redesign/catalog/CatalogTabs";
import { InstallSkillDialog } from "../redesign/catalog/InstallSkillDialog";
import { NewStageDialog } from "../redesign/catalog/NewStageDialog";
import type { NewStageInitial } from "../redesign/catalog/catalogStageModel";
import { useHotkeys } from "../redesign/keys";

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

  const visibleTab: CatalogTabId = tab === "extensions" ? "stages" : tab;

  return (
    <CatalogPageMain tab={visibleTab} skillName={skillName} />
  );
}

function CatalogPageMain({
  tab,
  skillName,
}: {
  tab: CatalogTabId;
  skillName?: string;
}) {
  const [query, setQuery] = useState("");
  const [stageDialog, setStageDialog] = useState<{
    initial: NewStageInitial | null;
  } | null>(null);
  const [installOpen, setInstallOpen] = useState(false);
  const [skillsReloadNonce, setSkillsReloadNonce] = useState(0);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const [stageCount, setStageCount] = useState<number>();
  const [skillCount, setSkillCount] = useState<number>();

  const loadCounts = useCallback(async () => {
    try {
      const [pipelines, skills] = await Promise.all([
        fetchPipelines(),
        fetchSkills(),
      ]);
      const stageIds = new Set<string>();
      for (const pipeline of pipelines.pipelines) {
        for (const stage of pipeline.stages) {
          stageIds.add(`${pipeline.project_root ?? ""}:${stage.id}`);
        }
      }
      setStageCount(stageIds.size);
      setSkillCount(skills.skills.length);
    } catch {
      setStageCount(undefined);
      setSkillCount(undefined);
    }
  }, []);

  useEffect(() => {
    void loadCounts();
  }, [loadCounts]);

  const openNewStage = useCallback((initial?: NewStageInitial) => {
    setStageDialog({ initial: initial ?? null });
  }, []);
  const closeNewStage = useCallback(() => setStageDialog(null), []);
  const openInstallSkill = useCallback(() => setInstallOpen(true), []);
  const closeInstallSkill = useCallback(() => setInstallOpen(false), []);

  useHotkeys(
    [
      {
        key: "/",
        scope: "catalog",
        handler: (e) => {
          e.preventDefault();
          searchRef.current?.focus();
          searchRef.current?.select();
        },
      },
      {
        key: "n",
        scope: "catalog",
        when: () => tab === "stages" && stageDialog === null,
        handler: (e) => {
          e.preventDefault();
          openNewStage();
        },
      },
      {
        key: "i",
        scope: "catalog",
        when: () => tab === "skills" && !installOpen && stageDialog === null,
        handler: (e) => {
          e.preventDefault();
          openInstallSkill();
        },
      },
    ],
    "catalog",
  );

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-[#0c0d0f]">
      <CatalogHeaderBar
        active={tab}
        stageCount={stageCount}
        skillCount={skillCount}
        query={query}
        onQueryChange={setQuery}
        searchRef={searchRef}
        onNewStage={() => openNewStage()}
        onInstallSkill={openInstallSkill}
      />
      <div className="flex min-h-0 flex-1 flex-col">
        {tab === "stages" ? (
          <CatalogStagesTab query={query} onNewStage={openNewStage} />
        ) : null}
        {tab === "skills" ? (
          <CatalogSkillsTab
            skillName={skillName}
            query={query}
            reloadNonce={skillsReloadNonce}
          />
        ) : null}
      </div>
      <NewStageDialog
        open={stageDialog !== null}
        initial={stageDialog?.initial ?? null}
        onClose={closeNewStage}
      />
      <InstallSkillDialog
        open={installOpen}
        onClose={closeInstallSkill}
        onInstalled={() => {
          setSkillsReloadNonce((n) => n + 1);
          void loadCounts();
        }}
      />
    </div>
  );
}
