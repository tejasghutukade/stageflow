import { LuNetwork } from "react-icons/lu";
import { CARD, MONO, PRIMARY, TILE } from "../identity/identityParts";
import { A2aError } from "./A2aParts";
import { OFF_FIRST_COPY, OFF_KEPT_COPY, PUBLIC_URL_MISSING_COPY } from "./a2aView";

const POINTS: Array<{ title: string; body: string }> = [
  { title: "Callers", body: "Each outside agent gets its own name and a token that is shown once." },
  { title: "Published pipelines", body: "Only the pipelines you publish can be called, and only by the callers you tick." },
  { title: "Reversible", body: "You can turn A2A off again. Callers, published pipelines and tokens are kept." },
];

export function A2aTurnOn({
  kept,
  busy,
  errorCode,
  errorDetail,
  onEnable,
}: {
  kept: boolean;
  busy: boolean;
  errorCode: string | null;
  errorDetail?: string;
  onEnable: () => void;
}) {
  const noAddress = errorCode === "a2a_public_url_required";
  return (
    <div className="mx-auto flex w-full max-w-[720px] flex-col gap-6 py-6" data-testid="a2a-turn-on">
      <div className="flex flex-col items-start gap-3">
        <span className={TILE}><LuNetwork className="block size-4 text-[#a7aab2]" aria-hidden /></span>
        <h2 className="text-xl font-semibold tracking-[-0.4px] text-[#ecedee]">
          {kept ? "A2A is turned off" : "Turn on A2A for this Host"}
        </h2>
        <p className="text-[13px] leading-[1.6] text-[#a7aab2]">{kept ? OFF_KEPT_COPY : OFF_FIRST_COPY}</p>
      </div>
      {kept ? null : (
        <ol className={`${CARD} flex flex-col`}>
          {POINTS.map((step, index) => (
            <li key={step.title} className={`flex gap-4 px-5 py-4 ${index > 0 ? "border-t border-t-[#ffffff12]" : ""}`}>
              <span className={`flex size-6 shrink-0 items-center justify-center rounded-full border border-[#ffffff1a] text-xs text-[#a7aab2] ${MONO}`}>{index + 1}</span>
              <span className="flex flex-col gap-0.5">
                <span className="text-[13px] font-medium text-[#ecedee]">{step.title}</span>
                <span className="text-xs leading-[1.5] text-[#8b8f98]">{step.body}</span>
              </span>
            </li>
          ))}
        </ol>
      )}
      {noAddress ? (
        <div className="flex flex-col gap-1 rounded-lg border border-[#f5b54447] bg-[#f5b5441a] px-4 py-3" role="alert" data-testid="a2a-no-public-url">
          <span className="text-[13px] font-medium text-[#ecedee]">This Host has no public address</span>
          <span className="text-xs leading-[1.5] text-[#a7aab2]">{PUBLIC_URL_MISSING_COPY}</span>
        </div>
      ) : errorCode ? (
        <A2aError code={errorCode} detail={errorDetail} />
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className={PRIMARY} onClick={onEnable} disabled={busy}>{busy ? "Turning on…" : "Turn on A2A"}</button>
        <span className="text-xs text-[#8b8f98]">
          Reference in <span className={MONO}>docs/a2a.md</span>.
        </span>
      </div>
    </div>
  );
}
