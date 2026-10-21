import type { IconType } from "react-icons";
import {
  LuClipboardList,
  LuFileText,
  LuFolderOpen,
  LuHand,
  LuMessageSquare,
  LuPackage,
  LuShieldCheck,
  LuSparkles,
  LuWorkflow,
} from "react-icons/lu";

export type WorkshopStarterKind = "describe" | "open" | "task";

const STARTERS: Array<{ kind: WorkshopStarterKind; icon: IconType; label: string }> = [
  { kind: "describe", icon: LuMessageSquare, label: "Describe a workflow" },
  { kind: "open", icon: LuFolderOpen, label: "Open existing pipeline…" },
  { kind: "task", icon: LuClipboardList, label: "Attach a task first" },
];

const CAPABILITIES: Array<{ icon: IconType; label: string; mono?: boolean }> = [
  { icon: LuWorkflow, label: "Pipeline wiring — entry, order, routing" },
  { icon: LuFileText, label: "Stage prompts" },
  { icon: LuShieldCheck, label: "io · verify · on_verify_fail", mono: true },
  { icon: LuHand, label: "HITL gates (ask_operator)" },
  { icon: LuPackage, label: "Envelopes & artifacts" },
];

export function WorkshopEmptyThread({
  onStarter,
}: {
  onStarter: (kind: WorkshopStarterKind) => void;
}) {
  return (
    <div className="flex w-full min-w-0 flex-col gap-4 px-4 py-5">
      <div className="flex items-start gap-2.5">
        <div className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md border border-[#ffffff1a] bg-[#1a1c21]">
          <LuSparkles aria-hidden className="size-3 text-[#ecedee]" />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium leading-normal text-[#ecedee]">Workshop Author</span>
            <span className="font-['Geist_Mono',monospace] text-[11px] leading-normal text-[#8b8f98]">
              now
            </span>
          </div>
          <p className="m-0 text-sm leading-[1.55] text-[#ecedee]">
            Hi — what are we building? Describe the workflow in a sentence or two, or open an
            existing pipeline to evolve it.
          </p>
        </div>
      </div>
      <div className="flex flex-wrap gap-2 pl-[34px]">
        {STARTERS.map(({ kind, icon: Icon, label }) => (
          <button
            key={kind}
            type="button"
            onClick={() => onStarter(kind)}
            className="flex h-[30px] items-center gap-1.5 rounded-lg border border-[#ffffff1a] bg-[#1a1c21] px-2.5 hover:border-[#ffffff33]"
          >
            <Icon aria-hidden className="size-3.5 text-[#a7aab2]" />
            <span className="whitespace-nowrap text-xs font-medium leading-normal text-[#ecedee]">
              {label}
            </span>
          </button>
        ))}
      </div>
      <div className="ml-[34px] flex flex-col gap-2 rounded-[10px] border border-[#ffffff12] bg-[#0f1013] px-3 py-2.5">
        <div className="text-[11px] font-medium uppercase leading-normal tracking-[0.88px] text-[#8b8f98]">
          What I can help with
        </div>
        {CAPABILITIES.map(({ icon: Icon, label, mono }) => (
          <div key={label} className="flex h-[22px] items-center gap-2">
            <Icon aria-hidden className="size-3.5 shrink-0 text-[#8b8f98]" />
            <span
              className={`text-[13px] leading-normal text-[#a7aab2] ${mono ? "whitespace-nowrap font-['Geist_Mono',monospace]" : ""}`}
            >
              {label}
            </span>
          </div>
        ))}
      </div>
      <p className="m-0 ml-[34px] text-xs leading-[1.45] text-[#8b8f98]">
        Edits land in this draft only. Nothing is written to disk until you Save.
      </p>
    </div>
  );
}
