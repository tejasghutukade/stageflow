import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { type CatalogState, type RunCatalog } from "./runCatalog";

const RunCatalogContext = createContext<RunCatalog | null>(null);

function useCatalog(): RunCatalog {
  const catalog = useContext(RunCatalogContext);
  if (catalog === null) {
    throw new Error("useRunCatalog must be used within RunCatalogProvider");
  }
  return catalog;
}

export function RunCatalogProvider({
  catalog,
  children,
}: {
  catalog: RunCatalog;
  children: ReactNode;
}): ReactNode {
  useEffect(() => {
    void catalog.start();
    return () => {
      catalog.stop();
    };
  }, [catalog]);

  return createElement(
    RunCatalogContext.Provider,
    { value: catalog },
    children,
  );
}

export function useRunCatalog(): CatalogState {
  const catalog = useCatalog();
  return useSyncExternalStore(catalog.subscribe, catalog.getState);
}

export function useRunCatalogHandle(): RunCatalog {
  return useCatalog();
}
