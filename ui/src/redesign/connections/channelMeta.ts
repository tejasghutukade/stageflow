import { useEffect, useState } from "react";
import { fetchChannelMeta, type ChannelMeta, type ChannelProviderMeta } from "../../api";

let cached: Promise<ChannelMeta> | undefined;

/** The host describes its providers and error codes once; the console keeps no tables of its own. */
export function loadChannelMeta(): Promise<ChannelMeta> {
  cached ??= fetchChannelMeta().catch((error: unknown) => {
    cached = undefined;
    throw error;
  });
  return cached;
}

export function resetChannelMetaForTests(): void {
  cached = undefined;
}

export function useChannelMeta(): { meta: ChannelMeta | null; failed: boolean } {
  const [state, setState] = useState<{ meta: ChannelMeta | null; failed: boolean }>({ meta: null, failed: false });
  useEffect(() => {
    let cancelled = false;
    void loadChannelMeta().then(
      (meta) => { if (!cancelled) setState({ meta, failed: false }); },
      () => { if (!cancelled) setState({ meta: null, failed: true }); },
    );
    return () => { cancelled = true; };
  }, []);
  return state;
}

export function providerOf(meta: ChannelMeta | null | undefined, id: string): ChannelProviderMeta | undefined {
  return meta?.providers.find((provider) => provider.id === id);
}

export function providerLabel(meta: ChannelMeta | null | undefined, id: string): string {
  return providerOf(meta, id)?.label ?? id;
}

/** The host's one-sentence explanation of a code, or the code itself when it has none. */
export function errorReason(meta: ChannelMeta | null | undefined, code: string): string {
  return meta?.errors[code]?.reason ?? code;
}

export function errorHint(meta: ChannelMeta | null | undefined, code: string | undefined): string | undefined {
  return code ? meta?.errors[code]?.hint : undefined;
}
