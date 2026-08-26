export type StageflowIconProps = {
  size?: number;
  className?: string;
};

export function StageflowIcon({ size = 16, className }: StageflowIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      className={className}
      aria-hidden="true"
    >
      <path
        d="M 12 20 C 28 20, 28 44, 52 44"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        fill="none"
      />
      <circle cx="12" cy="20" r="5" fill="currentColor" />
      <circle cx="32" cy="32" r="5" fill="currentColor" />
      <circle cx="52" cy="44" r="5" fill="currentColor" opacity="0.45" />
    </svg>
  );
}
