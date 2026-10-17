import React from "react";
import { interpolate, useCurrentFrame, Easing } from "remotion";

/** The Stageflow mark, drawn in. `t` is frames since the logo should start drawing. */
export const Logo: React.FC<{ size: number; color?: string; start?: number }> = ({ size, color = "#f4f4f6", start = 0 }) => {
  const f = useCurrentFrame() - start;
  const draw = interpolate(f, [0, 28], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) });
  const pop = (a: number) => interpolate(f, [a, a + 10], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.out(Easing.back(2)) });
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none">
      <path d="M 12 20 C 28 20, 28 44, 52 44" stroke={color} strokeWidth={2.5} strokeLinecap="round" fill="none" pathLength={1} strokeDasharray={1} strokeDashoffset={1 - draw} />
      <circle cx={12} cy={20} r={5 * pop(0)} fill={color} />
      <circle cx={32} cy={32} r={5 * pop(10)} fill={color} />
      <circle cx={52} cy={44} r={5 * pop(20)} fill={color} opacity={0.45} />
    </svg>
  );
};
