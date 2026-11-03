import { useCallback, useEffect, useRef, useState } from "react";
import { A2aApiError, a2aApi, type A2aCaller, type A2aPublication, type A2aStatus } from "../../api/a2a";
import { A2aScreen, type A2aTabId } from "./A2aScreen";
import { a2aScreen } from "./a2aView";

function failure(err: unknown): { code: string; detail: string } {
  return err instanceof A2aApiError ? { code: err.code, detail: err.detail } : { code: "request_failed", detail: "" };
}

export function A2aPage() {
  const mounted = useRef(true);
  const [status, setStatus] = useState<A2aStatus | null>(null);
  const [callers, setCallers] = useState<A2aCaller[]>([]);
  const [publications, setPublications] = useState<A2aPublication[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTab] = useState<A2aTabId>("callers");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<{ code: string; detail: string } | null>(null);
  const [issued, setIssued] = useState<{ caller: string; token: string } | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const reload = useCallback(async () => {
    try {
      const next = await a2aApi.status();
      if (!mounted.current) return;
      setStatus(next);
      setLoadError(null);
      if (next.state === "enabled") {
        const [callerRows, publicationRows] = await Promise.all([a2aApi.callers(), a2aApi.publications()]);
        if (!mounted.current) return;
        setCallers(callerRows);
        setPublications(publicationRows);
      } else {
        setCallers([]);
        setPublications([]);
      }
    } catch (err) {
      if (mounted.current) setLoadError(failure(err).code);
    }
    if (mounted.current) setNow(Date.now());
  }, []);

  useEffect(() => {
    mounted.current = true;
    setLoading(true);
    void reload().finally(() => {
      if (mounted.current) setLoading(false);
    });
    return () => {
      mounted.current = false;
    };
  }, [reload]);

  const act = useCallback(
    async (work: () => Promise<unknown>) => {
      setActionError(null);
      setBusy(true);
      try {
        await work();
      } catch (err) {
        if (mounted.current) setActionError(failure(err));
      }
      try {
        await reload();
      } finally {
        if (mounted.current) setBusy(false);
      }
    },
    [reload],
  );

  const screen = a2aScreen({ loading, loadError, status, callers });

  return (
    <A2aScreen
      screen={screen}
      status={status}
      callers={callers}
      publications={publications}
      tab={tab}
      busy={busy}
      now={now}
      loadError={loadError}
      actionError={actionError}
      issued={issued}
      onTab={(next) => { setActionError(null); setTab(next); }}
      onRetry={() => { setLoading(true); void reload().finally(() => { if (mounted.current) setLoading(false); }); }}
      onEnable={() => void act(() => a2aApi.enable())}
      onDisable={() => void act(async () => {
        await a2aApi.disable();
        setIssued(null);
      })}
      onReload={() => void act(() => a2aApi.reload())}
      onAddCaller={(name) => void act(async () => {
        const created = await a2aApi.createCaller(name);
        setIssued({ caller: created.id, token: created.token });
      })}
      onRevokeCaller={(id) => void act(async () => {
        await a2aApi.revokeCaller(id);
        setIssued((current) => (current?.caller === id ? null : current));
      })}
      onPublicationSaved={() => void act(async () => undefined)}
      onRemovePublication={(id) => void act(() => a2aApi.removePublication(id))}
      onDismissToken={() => setIssued(null)}
    />
  );
}
