import type { ReactNode } from "react";

export type AppShellProps = {
  rail: ReactNode;
  children: ReactNode;
};

export function AppShell({ rail, children }: AppShellProps) {
  return (
    <div
      className="sf-app grid h-screen grid-cols-[232px_1fr] bg-[var(--sf-ground)] font-['Geist',sans-serif] text-[var(--sf-text-1)]"
    >
      {rail}
      <main className="h-screen min-w-0 overflow-y-auto bg-[var(--sf-ground)]">
        {children}
      </main>
    </div>
  );
}
