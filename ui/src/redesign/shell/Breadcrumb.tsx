export type Crumb = { label: string; onClick?: () => void };

export function Breadcrumb({ items, trailingSlash = false }: { items: Crumb[]; trailingSlash?: boolean }) {
  return (
    <nav className="flex items-center text-[13px] leading-normal text-[var(--sf-text-3)]" aria-label="Breadcrumb">
      {items.map((item, index) => (
        <span key={`${item.label}-${index}`} className="flex items-center">
          {index > 0 ? <span className="px-1">/</span> : null}
          {item.onClick ? (
            <button type="button" onClick={item.onClick} className="hover:text-[var(--sf-text-2)]">
              {item.label}
            </button>
          ) : (
            <span>{item.label}</span>
          )}
        </span>
      ))}
      {trailingSlash ? <span className="px-1">/</span> : null}
    </nav>
  );
}
