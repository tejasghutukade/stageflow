import type { ReactNode } from "react";

export type DataTableRowProps = {
  selected?: boolean;
  needs?: boolean;
  onClick?: () => void;
  children: ReactNode;
  variant?: "table" | "gate";
  className?: string;
};

export function DataTableRow({
  selected,
  needs,
  onClick,
  children,
  variant = "table",
  className,
}: DataTableRowProps) {
  if (variant === "gate") {
    return (
      <button
        type="button"
        onClick={onClick}
        className={`flex w-full gap-3 rounded-[10px] p-3 text-left${
          selected && needs
            ? " border border-[#f5b54447] bg-[#16140f]"
            : ""
        }`}
      >
        {children}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      className={`block w-full border-b border-b-[#ffffff12] text-left text-[var(--sf-text-1)] hover:bg-[var(--sf-raised)]${
        selected ? " bg-[var(--sf-active)]" : " bg-transparent"
      }${className ? ` ${className}` : " px-5 py-2.5"}`}
    >
      {children}
    </button>
  );
}

export type DataTableProps = {
  children: ReactNode;
  className?: string;
};

export function DataTable({ children, className }: DataTableProps) {
  return (
    <div className={`flex flex-col${className ? ` ${className}` : ""}`}>
      {children}
    </div>
  );
}
