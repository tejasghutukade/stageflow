import type { IconType } from "react-icons";
import {
  LuBot,
  LuInbox,
  LuLayers,
  LuList,
  LuPenLine,
  LuSparkles,
  LuZap,
} from "react-icons/lu";

export type NavItem = {
  id: string;
  label: string;
  href: string;
  icon: IconType;
  badge?: "waiting" | "inFlight";
  soon?: boolean;
};

export type NavGroup = {
  label: string;
  items: NavItem[];
};

export const NAV_GROUPS: NavGroup[] = [
  {
    label: "Operate",
    items: [
      { id: "inbox", label: "Inbox", href: "#/inbox", icon: LuInbox, badge: "waiting" },
      { id: "runs", label: "Runs", href: "#/runs", icon: LuList, badge: "inFlight" },
    ],
  },
  {
    label: "Build",
    items: [
      { id: "pipelines", label: "Pipelines", href: "#/pipelines", icon: LuLayers },
      { id: "workshop", label: "Workshop", href: "#/workshop", icon: LuPenLine },
      { id: "tasks", label: "Tasks", href: "#/tasks", icon: LuList },
      { id: "catalog", label: "Catalog", href: "#/catalog?tab=stages", icon: LuSparkles },
    ],
  },
  {
    label: "Automate",
    items: [
      { id: "triggers", label: "Triggers", href: "#/triggers", icon: LuZap },
      { id: "agents", label: "Agents", href: "#", icon: LuBot, soon: true },
    ],
  },
];
