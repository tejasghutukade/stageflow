import { LuKeyRound, LuTriangleAlert } from "react-icons/lu";
import { CopyButton, GHOST, MONO } from "../identity/identityParts";
import { TOKEN_ONCE_COPY, a2aErrorCopy } from "./a2aView";

export function A2aError({ code, detail }: { code: string; detail?: string }) {
  const copy = a2aErrorCopy(code);
  return (
    <div
      className="flex items-start gap-2 rounded-lg border border-[#f2645a47] bg-[#f2645a14] px-3 py-2.5 text-[13px] text-[#f2645a]"
      role="alert"
    >
      <LuTriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <div className="flex min-w-0 flex-col gap-0.5">
        <span>{copy.title}</span>
        {copy.hint ? <span className="text-xs text-[#a7aab2]">{copy.hint}</span> : null}
        {detail ? <span className={`break-words text-xs text-[#a7aab2] ${MONO}`}>{detail}</span> : null}
        <span className={`text-[11px] text-[#8b8f98] ${MONO}`}>{copy.code}</span>
      </div>
    </div>
  );
}

export function NewTokenNotice({ caller, token, onDismiss }: { caller: string; token: string; onDismiss: () => void }) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-[#f5b54447] bg-[#f5b5441a] px-4 py-3" role="status" data-testid="a2a-new-token">
      <div className="flex items-start gap-3">
        <LuKeyRound className="mt-0.5 block size-4 shrink-0 text-[#f5b544]" aria-hidden />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="text-[13px] font-medium text-[#ecedee]">
            Token for <span className={MONO}>{caller}</span>
          </span>
          <span className="text-xs leading-[1.5] text-[#a7aab2]">{TOKEN_ONCE_COPY}</span>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <code className={`min-w-0 flex-1 break-all rounded-md border border-[#ffffff1a] bg-[#0c0d0f] px-3 py-2 text-xs text-[#ecedee] ${MONO}`}>{token}</code>
        <CopyButton value={token} label="Copy token" />
      </div>
      <div>
        <button type="button" className={GHOST} onClick={onDismiss}>I have copied it</button>
      </div>
    </div>
  );
}

export function AddressRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-xs text-[#8b8f98]">{label}</span>
        <span className={`break-all text-[13px] text-[#ecedee] ${MONO}`}>{value}</span>
      </div>
      <CopyButton value={value} />
    </div>
  );
}
