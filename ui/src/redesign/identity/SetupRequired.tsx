import { LuShield } from "react-icons/lu";
import { CARD, IdentityError, MONO, PRIMARY, SECONDARY, TILE } from "./identityParts";

const MANAGED_POINTS: Array<{ title: string; body: string }> = [
  { title: "A private database for this Workspace", body: "Created on this Host, in its data directory. No extra service to run." },
  { title: "Built-in access rules to start", body: "They decide who may see which order. Nothing is read from your systems until you connect an order API." },
  { title: "Reversible", body: "You can turn identity off again. What you saved is kept." },
];

const EMBEDDED_STEPS: Array<{ title: string; body: string }> = [
  { title: "Create the identity store", body: "One database per Workspace, in a persistent, owner-only Host data directory." },
  { title: "Choose a policy engine and order adapter", body: "The in-process scope engine or Cerbos, plus a read-only adapter for your order API." },
  { title: "Pass consumerAuthorization to startUiServer", body: "The app that embeds this Host does this in code." },
];

export function SetupRequired({
  mode = "managed",
  busy,
  error,
  onEnable,
  onRetry,
}: {
  mode?: "managed" | "embedded";
  busy: boolean;
  error?: string | null;
  onEnable?: () => void;
  onRetry: () => void;
}) {
  const managed = mode === "managed";
  const points = managed ? MANAGED_POINTS : EMBEDDED_STEPS;
  return (
    <div className="mx-auto flex w-full max-w-[720px] flex-col gap-6 py-6" data-testid="identity-setup-required">
      <div className="flex flex-col items-start gap-3">
        <span className={TILE}><LuShield className="block size-4 text-[#a7aab2]" aria-hidden /></span>
        <h2 className="text-xl font-semibold tracking-[-0.4px] text-[#ecedee]">
          {managed ? "Turn on identity for this Host" : "Identity isn't switched on for this Host"}
        </h2>
        <p className="text-[13px] leading-[1.6] text-[#a7aab2]">
          Identity lets a business&apos;s customers and employees sign in to its agents and see only what they should.
          {managed
            ? " Turn it on here; there is nothing to install or restart."
            : " The app that runs this Host manages it in code, so it cannot be switched on from the console."}
        </p>
      </div>
      <ol className={`${CARD} flex flex-col`}>
        {points.map((step, index) => (
          <li key={step.title} className={`flex gap-4 px-5 py-4 ${index > 0 ? "border-t border-t-[#ffffff12]" : ""}`}>
            <span className={`flex size-6 shrink-0 items-center justify-center rounded-full border border-[#ffffff1a] text-xs text-[#a7aab2] ${MONO}`}>{index + 1}</span>
            <span className="flex flex-col gap-0.5">
              <span className="text-[13px] font-medium text-[#ecedee]">{step.title}</span>
              <span className="text-xs leading-[1.5] text-[#8b8f98]">{step.body}</span>
            </span>
          </li>
        ))}
      </ol>
      {error ? <IdentityError code={error} /> : null}
      <div className="flex flex-wrap items-center gap-3">
        {managed ? (
          <button type="button" className={PRIMARY} onClick={onEnable} disabled={busy}>{busy ? "Turning on…" : "Turn on identity"}</button>
        ) : (
          <button type="button" className={SECONDARY} onClick={onRetry} disabled={busy}>Check again</button>
        )}
        <span className="text-xs text-[#8b8f98]">
          Walkthrough in <span className={MONO}>docs/consumer-identity.md</span>.
        </span>
      </div>
    </div>
  );
}
