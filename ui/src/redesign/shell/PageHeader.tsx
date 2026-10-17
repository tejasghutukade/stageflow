import type { ReactNode } from "react";
import { Breadcrumb, type Crumb } from "./Breadcrumb";

export type PageHeaderProps = {
  title: ReactNode;
  /** Second line under the title; stacks inside the 56px bar. */
  subtitle?: string;
  /** Right after the title: count, status pills, tabs. */
  titleAddon?: ReactNode;
  /** Only linked crumbs render, as a back path before the title. */
  crumbs?: Crumb[];
  /** Right-aligned slot between the title block and the actions (search, filters). */
  children?: ReactNode;
  actions?: ReactNode;
  /** Band below the bar. */
  description?: ReactNode;
  meta?: ReactNode;
  variant?: "bar" | "inbox";
  className?: string;
};

export function PageHeader({
  title,
  subtitle,
  titleAddon,
  crumbs,
  children,
  actions,
  description,
  meta,
  variant = "bar",
  className,
}: PageHeaderProps) {
  const extra = className ? ` ${className}` : "";
  if (variant === "inbox") {
    return (
      <div className={`flex h-14 w-full shrink-0 items-center justify-between px-7${extra}`}>
        <div className="flex items-center gap-2.5">
          <h1 className="text-xl font-semibold leading-normal tracking-[-0.4px] text-[var(--sf-text-1)]">{title}</h1>
          {titleAddon}
        </div>
        {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
      </div>
    );
  }

  const back = (crumbs ?? []).filter((crumb) => crumb.onClick);
  return (
    <>
      <header
        className={`flex h-14 w-full shrink-0 items-center justify-between gap-4 border-b border-b-[#ffffff12] px-5${extra}`}
      >
        <div className="flex min-w-0 items-center gap-2.5">
          {back.length > 0 ? <Breadcrumb items={back} trailingSlash /> : null}
          <div className="flex min-w-0 flex-col justify-center">
            <h1 className="truncate text-xl font-semibold leading-normal tracking-[-0.4px] text-[var(--sf-text-1)]">
              {title}
            </h1>
            {subtitle ? <p className="text-[13px] leading-tight text-[var(--sf-text-2)]">{subtitle}</p> : null}
          </div>
          {titleAddon}
        </div>
        {children ? <div className="flex min-w-0 flex-1 items-center justify-end gap-2">{children}</div> : null}
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </header>
      {description || meta ? (
        <div className="flex shrink-0 flex-col gap-1.5 border-b border-b-[#ffffff12] px-5 py-2.5">
          {description ? <div className="text-[13px] leading-normal text-[var(--sf-text-2)]">{description}</div> : null}
          {meta}
        </div>
      ) : null}
    </>
  );
}
