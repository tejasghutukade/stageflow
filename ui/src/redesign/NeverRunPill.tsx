import { LuClock } from "react-icons/lu";

export function NeverRunPill() {
  return (
    <span
      className="flex h-6 items-center gap-[5px] rounded-full border border-dashed border-[#a7aab266] px-2 text-[#a7aab2]"
      aria-label="Never run"
    >
      <LuClock className="size-3 shrink-0" aria-hidden="true" />
      <span className="text-xs font-medium leading-normal">Never run</span>
    </span>
  );
}
