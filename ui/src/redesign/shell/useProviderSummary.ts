import { useCallback, useEffect, useState } from "react";
import { fetchProviderAuth, fetchProviders } from "../../api";
import { providerRowLabel } from "./providerRowLabel";

export type ProviderSummaryState = {
  label: string;
  ready: boolean;
  loading: boolean;
  connectedCount: number;
  failed: boolean;
};

const CACHE_MS = 30_000;

let cached: { at: number; value: ProviderSummaryState } | null = null;

export function useProviderSummary(): ProviderSummaryState {
  const [state, setState] = useState<ProviderSummaryState>(() =>
    cached?.value ?? {
      label: "—",
      ready: false,
      loading: true,
      connectedCount: 0,
      failed: false,
    },
  );

  const load = useCallback(async () => {
    const now = Date.now();
    if (cached && now - cached.at < CACHE_MS) {
      setState(cached.value);
      return;
    }
    setState((prev) => ({ ...prev, loading: true }));
    try {
      const { providers } = await fetchProviders();
      if (providers.length === 0) {
        const value = {
          label: "No providers",
          ready: false,
          loading: false,
          connectedCount: 0,
          failed: false,
        };
        cached = { at: now, value };
        setState(value);
        return;
      }
      const statuses = await Promise.all(
        providers.map(async (p) => {
          try {
            const { provider } = await fetchProviderAuth(p.id);
            return provider.configured === true;
          } catch {
            return false;
          }
        }),
      );
      const configuredIds = providers
        .filter((_, i) => statuses[i])
        .map((p) => p.id);
      const ready =
        configuredIds.length > 0 && configuredIds.length === providers.length;
      const label =
        configuredIds.length === 0
          ? "No providers"
          : providerRowLabel(configuredIds);
      const value = {
        label,
        ready,
        loading: false,
        connectedCount: configuredIds.length,
        failed: false,
      };
      cached = { at: now, value };
      setState(value);
    } catch {
      setState({
        label: "Providers unavailable",
        ready: false,
        loading: false,
        connectedCount: 0,
        failed: true,
      });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return state;
}
