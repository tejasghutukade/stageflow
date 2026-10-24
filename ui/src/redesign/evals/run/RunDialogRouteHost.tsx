import { useEffect } from "react";
import type { Route } from "../../../routes";
import { RunDialogHost } from "./RunDialog";
import { openRunDialog, openRunTargetFromRoute, pathWithoutOpenRun } from "./runDialogStore";

export function RunDialogRouteHost({ route }: { route: Route }) {
  const target = openRunTargetFromRoute(route);
  const evalId = target?.evalId;

  useEffect(() => {
    if (!evalId) return;
    openRunDialog(evalId);
    const clean = pathWithoutOpenRun(route);
    if (clean !== null) {
      window.history.replaceState(null, "", `#${clean}`);
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [evalId]);

  return <RunDialogHost />;
}
