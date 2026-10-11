import { useEffect, useState } from "react";
import {
  getControlToken,
  setControlToken,
  subscribeControlTokenRequired,
  wasControlTokenRequired,
} from "../api/controlToken";

export function ControlTokenGate() {
  const [open, setOpen] = useState(wasControlTokenRequired);
  const [token, setToken] = useState("");

  useEffect(() => {
    if (wasControlTokenRequired()) setOpen(true);
    return subscribeControlTokenRequired(() => {
      setToken(getControlToken());
      setOpen(true);
    });
  }, []);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-[#0c0d0fcc] p-6">
      <form
        className="flex w-full max-w-md flex-col gap-3 rounded-xl border border-[#ffffff12] bg-[var(--sf-panel)] p-4"
        onSubmit={(event) => {
          event.preventDefault();
          setControlToken(token);
          window.location.reload();
        }}
      >
        <h2 className="font-sans text-[15px] font-semibold text-[var(--sf-text-1)]">
          Control token
        </h2>
        <p className="font-sans text-xs text-[var(--sf-text-3)]">
          This Host rejected the request. Paste STAGEFLOW_CONTROL_TOKEN from the
          machine running Stageflow. It stays in this browser.
        </p>
        <input
          type="password"
          autoComplete="off"
          autoFocus
          value={token}
          onChange={(event) => setToken(event.target.value)}
          placeholder="STAGEFLOW_CONTROL_TOKEN"
          className="h-8 rounded-lg border border-[#ffffff1a] bg-[var(--sf-raised)] px-2.5 font-['Geist_Mono',monospace] text-[13px] text-[var(--sf-text-1)] outline-none"
        />
        <button
          type="submit"
          className="h-8 self-start rounded-lg bg-[#ecedee] px-3 font-sans text-[13px] font-medium text-[#0c0d0f]"
        >
          Save and reload
        </button>
      </form>
    </div>
  );
}
