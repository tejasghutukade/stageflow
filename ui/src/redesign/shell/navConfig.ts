import type { IconType } from "react-icons";
import {
  LuBot,
  LuInbox,
  LuLayers,
  LuList,
  LuMessagesSquare,
  LuPlug,
  LuSparkles,
  LuZap,
} from "react-icons/lu";

export type NavItem = {
  id: string;
  label: string;
  href: string;
  icon: IconType;
  badge?: "waiting" | "inFlight" | "agentsActive";
  soon?: boolean;
};

export type NavGroup = {
  /** Omitted for a pinned group that sits above the sections (Inbox). */
  label?: string;
  items: NavItem[];
};

export const NAV_GROUPS: NavGroup[] = [
  {
    items: [{ id: "inbox", label: "Inbox", href: "#/inbox", icon: LuInbox, badge: "waiting" }],
  },
  {
    label: "Activity",
    items: [
      { id: "runs", label: "Pipeline runs", href: "#/runs", icon: LuList, badge: "inFlight" },
      { id: "agent-sessions", label: "Agent sessions", href: "#/agent-sessions", icon: LuMessagesSquare, badge: "agentsActive" },
    ],
  },
  {
    label: "Build",
    items: [
      { id: "pipelines", label: "Pipelines", href: "#/pipelines", icon: LuLayers },
      { id: "agents", label: "Agents", href: "#/agents", icon: LuBot },
      { id: "tasks", label: "Tasks", href: "#/tasks", icon: LuList },
      { id: "catalog", label: "Catalog", href: "#/catalog?tab=stages", icon: LuSparkles },
    ],
  },
  {
    label: "Connect",
    items: [
      { id: "triggers", label: "Triggers", href: "#/triggers", icon: LuZap },
      { id: "connections", label: "Connections", href: "#/connections", icon: LuPlug },
    ],
  },
];
