import React from "react";
import { interpolate, useCurrentFrame, Easing } from "remotion";
import { C, FONT } from "./theme";

export type Cap = { from: number; to: number; title: string; sub?: string; pos?: "top" | "bottom" };

/** Lower-third caption. `from`/`to` are output frames inside the scene. */
export const Captions: React.FC<{ caps: Cap[] }> = ({ caps }) => {
  const f = useCurrentFrame();
  return (
    <>
      {caps.map((c, i) => {
        if (f < c.from - 2 || f > c.to + 2) return null;
        const inA = interpolate(f, [c.from, c.from + 10], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) });
        const outA = interpolate(f, [c.to - 8, c.to], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
        const o = Math.min(inA, outA);
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              ...(c.pos === "top" ? { top: 56 } : { bottom: 64 }),
              display: "flex",
              justifyContent: "center",
              opacity: o,
              transform: `translateY(${(1 - inA) * 14 * (c.pos === "top" ? -1 : 1)}px)`,
            }}
          >
            <div
              style={{
                fontFamily: FONT,
                background: "rgba(8,8,10,0.86)",
                border: `1px solid ${C.line}`,
                backdropFilter: "blur(14px)",
                borderRadius: 18,
                padding: c.sub ? "18px 34px 20px" : "16px 34px",
                textAlign: "center",
                boxShadow: "0 18px 50px rgba(0,0,0,0.55)",
                maxWidth: 1400,
              }}
            >
              <div style={{ fontSize: 40, fontWeight: 650, color: C.text, letterSpacing: -0.5 }}>{c.title}</div>
              {c.sub ? <div style={{ fontSize: 25, color: C.text2, marginTop: 6 }}>{c.sub}</div> : null}
            </div>
          </div>
        );
      })}
    </>
  );
};
