import { FilterTabs } from "../shell/FilterTabs";
import { catalogPath } from "../../routes";
import { navigate } from "../../routes";

export type CatalogTabId = "stages" | "skills" | "extensions";

export type CatalogTabsProps = {
  active: CatalogTabId;
};

export function CatalogTabs({ active }: CatalogTabsProps) {
  return (
    <FilterTabs
      activeId={active}
      onChange={(id) => navigate(catalogPath({ tab: id as CatalogTabId }))}
      tabs={[
        { id: "stages", label: "Stages" },
        { id: "skills", label: "Skills" },
        { id: "extensions", label: "Extensions" },
      ]}
    />
  );
}
