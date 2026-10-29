import { useCallback, useEffect, useState } from "react";
import { LuChrome, LuCircleAlert, LuTrash2, LuUndo2 } from "react-icons/lu";
import { deleteBrowserProfile, fetchBrowserProfiles, unpinBrowserProfile, type BrowserProfile } from "../../api";
import { browserLoginRow, type BrowserLoginRow } from "./browserLoginsModel";

const MONO = "[font-family:'Geist_Mono',_monospace]";
const EYEBROW = "text-[#8b8f98] font-sans text-[11px] font-medium leading-normal tracking-[0.88px] uppercase [white-space-collapse:collapse] [text-wrap-mode:nowrap]";
const GRID = "grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_120px_120px_168px] items-start gap-4";
const BUTTON = "flex h-7 items-center gap-1.5 rounded-md border border-[#ffffff1a] bg-transparent px-2 text-xs text-[#a7aab2] hover:bg-[#1a1c21] disabled:opacity-60";

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function LoginRow({
  row,
  confirming,
  working,
  onAskDelete,
  onCancelDelete,
  onDelete,
  onUnpin,
}: {
  row: BrowserLoginRow;
  confirming: boolean;
  working: boolean;
  onAskDelete: () => void;
  onCancelDelete: () => void;
  onDelete: () => void;
  onUnpin: () => void;
}) {
  return (
    <div className="border-t border-t-[#ffffff12] px-4 py-3" data-testid={`browser-login-${row.name}`}>
      <div className={GRID}>
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className={`truncate text-[13px] font-medium leading-normal text-[#ecedee] ${MONO}`}>{row.name}</span>
          <span className="truncate text-xs leading-normal text-[#8b8f98]" title={row.sites}>{row.sites}</span>
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-[13px] leading-normal text-[#ecedee]">{row.where}</span>
          {row.pin ? (
            <span className="flex items-start gap-1.5 text-xs leading-[1.4] text-[#f5b544]" title={row.pin.detail}>
              <LuChrome className="mt-[2px] size-3 shrink-0" aria-hidden />
              <span>{row.pin.label}</span>
            </span>
          ) : null}
          {row.busy ? <span className="text-xs leading-[1.4] text-[#8b8f98]">{row.busy}</span> : null}
        </div>
        <span className={`text-xs leading-normal text-[#a7aab2] ${MONO}`}>{row.loggedIn}</span>
        <span className={`text-xs leading-normal text-[#a7aab2] ${MONO}`}>{row.lastUsed}</span>
        <div className="flex flex-wrap justify-end gap-2">
          {row.pin?.canUnpin ? (
            <button type="button" className={BUTTON} disabled={working} onClick={onUnpin} title="Try the Host's own browser again for this profile">
              <LuUndo2 className="size-3 block" aria-hidden />
              Switch back
            </button>
          ) : null}
          <button type="button" className={BUTTON} disabled={working || !row.canDelete} onClick={onAskDelete} aria-label={`Delete login ${row.name}`}>
            <LuTrash2 className="size-3 block" aria-hidden />
            Delete
          </button>
        </div>
      </div>
      {row.pin ? <p className="mt-2 max-w-[760px] text-xs leading-[1.5] text-[#8b8f98]">{row.pin.detail}</p> : null}
      {confirming ? (
        <div className="mt-3 flex max-w-[760px] flex-col gap-2 rounded-lg border border-[#f5b54447] bg-[#16140f] px-3 py-3" role="alertdialog" aria-label={`Confirm deleting ${row.name}`}>
          {row.deleteWarning.map((line) => (
            <p key={line} className="text-[13px] leading-[1.5] text-[#e6d3a3]">{line}</p>
          ))}
          <div className="flex gap-2">
            <button type="button" className="flex h-7 items-center rounded-md bg-[#f5b544] px-3 text-xs font-medium text-[#1a1306] disabled:opacity-60" disabled={working} onClick={onDelete}>
              {working ? "Deleting" : "Delete login data"}
            </button>
            <button type="button" className={BUTTON} disabled={working} onClick={onCancelDelete}>Cancel</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** The saved browser logins this Host holds: which sites, where each was made, and the two actions Stageflow can take. */
export function BrowserLoginsSection() {
  const [profiles, setProfiles] = useState<BrowserProfile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      setProfiles(await fetchBrowserProfiles());
      setError(null);
    } catch (err) {
      setError(describe(err));
      setProfiles((current) => current ?? []);
    }
    setNow(Date.now());
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const act = useCallback(
    async (name: string, run: () => Promise<unknown>) => {
      setWorking(name);
      setError(null);
      try {
        await run();
        setConfirming(null);
        await load();
      } catch (err) {
        setError(describe(err));
      } finally {
        setWorking(null);
      }
    },
    [load],
  );

  const rows = (profiles ?? []).map((profile) => browserLoginRow(profile, now));

  return (
    <section className="flex flex-col gap-4" aria-label="Browser logins">
      <div className="flex items-end justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="text-[15px] font-semibold leading-normal text-[#ecedee]">Browser logins</h2>
          <p className="text-[13px] leading-normal text-[#a7aab2]">
            Sites a stage&apos;s browser stays logged in to. Delete removes this Host&apos;s copy; it does not sign you out on the site.
          </p>
        </div>
        {profiles !== null ? <span className={`shrink-0 text-xs leading-normal text-[#8b8f98] ${MONO}`}>{rows.length} saved</span> : null}
      </div>
      {error ? (
        <div className="flex items-start gap-2 rounded-lg border border-[#f5b54447] bg-[#16140f] px-3 py-2.5 text-[13px] text-[#f5b544]" role="alert">
          <LuCircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {error}
        </div>
      ) : null}
      {profiles === null ? <div className="text-[13px] text-[#8b8f98]">Loading browser logins…</div> : null}
      {profiles !== null && rows.length === 0 && !error ? (
        <div className="rounded-lg border border-[#ffffff12] bg-[#131418] px-6 py-6 text-[13px] leading-[1.5] text-[#a7aab2]" data-testid="browser-logins-empty">
          No saved browser logins yet. One appears here after a stage with a browser profile logs in to a site.
        </div>
      ) : null}
      {rows.length > 0 ? (
        <div className="overflow-hidden rounded-lg border border-[#ffffff12] bg-[#131418]">
          <div className={`${GRID} px-4 py-2.5`}>
            <span className={EYEBROW}>Profile</span>
            <span className={EYEBROW}>Login made in</span>
            <span className={EYEBROW}>Last login</span>
            <span className={EYEBROW}>Last used</span>
            <span />
          </div>
          {rows.map((row) => (
            <LoginRow
              key={row.name}
              row={row}
              confirming={confirming === row.name}
              working={working === row.name}
              onAskDelete={() => setConfirming(row.name)}
              onCancelDelete={() => setConfirming(null)}
              onDelete={() => void act(row.name, () => deleteBrowserProfile(row.name))}
              onUnpin={() => void act(row.name, () => unpinBrowserProfile(row.name))}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}
