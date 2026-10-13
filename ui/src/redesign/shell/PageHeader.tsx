import type { ReactNode } from "react";

export type PageHeaderProps = {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  titleAddon?: ReactNode;
  variant?: "bar" | "inbox";
  className?: string;
};

export function PageHeader({
  title,
  subtitle,
  actions,
  titleAddon,
  variant = "bar",
  className,
}: PageHeaderProps) {
  if (variant === "inbox") {
    return (
      <div
        className={`flex h-14 w-full shrink-0 items-center justify-between px-7${className ? ` ${className}` : ""}`}
      >
        <div className="flex items-center gap-2.5">
          <h1 className="text-xl font-semibold tracking-[-0.4px] text-[var(--sf-text-1)]">
            {title}
          </h1>
          {titleAddon}
        </div>
        {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
      </div>
    );
  }

  return (
    <header
      className={`flex w-full shrink-0 items-baseline justify-between gap-2.5 border-b border-b-[#ffffff12] px-5 py-0 h-14${className ? ` ${className}` : ""}`}
    >
      <div className="flex min-w-0 flex-col justify-center">
        <h1 className="text-xl font-semibold tracking-[-0.4px] text-[var(--sf-text-1)]">
          {title}
        </h1>
        {subtitle ? (
          <p className="mt-0.5 text-[13px] text-[var(--sf-text-2)]">{subtitle}</p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  );
}
