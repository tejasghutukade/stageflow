import type { IconType } from "react-icons";
import {
  LuBot,
  LuFlaskConical,
  LuInbox,
  LuLayers,
  LuLayoutDashboard,
  LuList,
  LuMessagesSquare,
  LuPlug,
  LuNetwork,
  LuShield,
  LuBookOpen,
  LuCompass,
  LuSparkles,
  LuSquareFunction,
  LuZap,
} from "react-icons/lu";

export type NavItem = {
  id: string;
  label: string;
  href: string;
  icon: IconType;
  badge?: "waiting" | "inFlight" | "agentsActive";
  soon?: boolean;
  /** Shown, and still navigable. The feature works; its shape may change. */
  experimental?: boolean;
};

export type NavGroup = {
  /** Omitted for a pinned group that sits above the sections (Inbox). */
  label?: string;
  items: NavItem[];
};

export const NAV_GROUPS: NavGroup[] = [
  {
    items: [
      { id: "guide", label: "Guide", href: "#/guide", icon: LuCompass },
      { id: "overview", label: "Overview", href: "#/overview", icon: LuLayoutDashboard },
      { id: "inbox", label: "Inbox", href: "#/inbox", icon: LuInbox, badge: "waiting" },
    ],
  },
  {
    label: "Activity",
    items: [
      { id: "runs", label: "Pipeline runs", href: "#/runs", icon: LuList, badge: "inFlight" },
      { id: "agent-sessions", label: "Agent sessions", href: "#/agent-sessions", icon: LuMessagesSquare, badge: "agentsActive", experimental: true },
    ],
  },
  {
    label: "Build",
    items: [
      { id: "pipelines", label: "Pipelines", href: "#/pipelines", icon: LuLayers },
      { id: "agents", label: "Agents", href: "#/agents", icon: LuBot, experimental: true },
      { id: "functions", label: "Functions", href: "#/functions", icon: LuSquareFunction },
      { id: "tasks", label: "Tasks", href: "#/tasks", icon: LuList },
      { id: "catalog", label: "Catalog", href: "#/catalog?tab=stages", icon: LuSparkles },
      { id: "evals", label: "Evals", href: "#/evals", icon: LuFlaskConical },
    ],
  },
  {
    label: "Connect",
    items: [
      { id: "triggers", label: "Triggers", href: "#/triggers", icon: LuZap },
      { id: "connections", label: "Connections", href: "#/connections", icon: LuPlug, experimental: true },
      { id: "identity", label: "Identity", href: "#/identity", icon: LuShield, experimental: true },
      { id: "a2a", label: "A2A", href: "#/a2a", icon: LuNetwork, experimental: true },
      { id: "memories", label: "Memories", href: "#/memories", icon: LuBookOpen },
    ],
  },
];
