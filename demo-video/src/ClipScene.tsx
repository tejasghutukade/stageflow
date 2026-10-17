import React from "react";
import { AbsoluteFill, Easing, interpolate, OffthreadVideo, Sequence, staticFile, useCurrentFrame } from "remotion";
import { Backdrop } from "./Backdrop";
import { Captions, Cap } from "./Caption";
import { C, FONT, FPS } from "./theme";

export type Seg = { from: number; to: number; speed: number }; // source seconds
export type SrcCap = { at: number; until: number; title: string; sub?: string; pos?: "top" | "bottom" };
export type Focus = { t: number; x: number; y: number; s: number }; // source seconds, centre (0..1), scale

export type ClipConfig = {
  clip: string;
  segs: Seg[];
  caps: SrcCap[];
  focus?: Focus[];
  label?: string;
};

export function outDuration(segs: Seg[]) {
  return segs.reduce((a, s) => a + (s.to - s.from) / s.speed, 0);
}

function mapper(segs: Seg[]) {
  const offs: number[] = [];
  let acc = 0;
  for (const s of segs) {
    offs.push(acc);
    acc += (s.to - s.from) / s.speed;
  }
  return (t: number) => {
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      if (t <= s.to + 1e-6) return offs[i] + Math.max(0, t - s.from) / s.speed;
    }
    return acc;
  };
}

const W = 1760;
const H = 990;
const CHROME = 30;

export const ClipScene: React.FC<ClipConfig> = ({ clip, segs, caps, focus = [], label }) => {
  const f = useCurrentFrame();
  const toOut = mapper(segs);
  const total = Math.round(outDuration(segs) * FPS);
  const frames = [0, ...focus.map((k) => toOut(k.t) * FPS)];
  const base = { x: 0.5, y: 0.5, s: 1 };
  const ks = [base, ...focus.map((k) => ({ x: k.x, y: k.y, s: k.s }))];
  const ease = { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.inOut(Easing.cubic) } as const;
  const s = frames.length > 1 ? interpolate(f, frames, ks.map((k) => k.s), ease) : 1;
  const rawX = frames.length > 1 ? interpolate(f, frames, ks.map((k) => k.x), ease) : 0.5;
  const rawY = frames.length > 1 ? interpolate(f, frames, ks.map((k) => k.y), ease) : 0.5;
  const x = Math.min(1 - 0.5 / s, Math.max(0.5 / s, rawX));
  const y = Math.min(1 - 0.5 / s, Math.max(0.5 / s, rawY));
  const fadeIn = interpolate(f, [0, 12], [0, 1], { extrapolateRight: "clamp" });
  const fadeOut = interpolate(f, [total - 12, total], [1, 0], { extrapolateLeft: "clamp" });
  const enter = interpolate(f, [0, 16], [24, 0], { extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) });

  let off = 0;
  const seqs = segs.map((sg, i) => {
    const d = Math.round(((sg.to - sg.from) / sg.speed) * FPS);
    const el = (
      <Sequence key={i} from={off} durationInFrames={d}>
        <OffthreadVideo
          src={staticFile(`clips/${clip}.webm`)}
          startFrom={Math.round(sg.from * FPS)}
          endAt={Math.round(sg.to * FPS)}
          playbackRate={sg.speed}
          muted
          style={{ width: W, height: H }}
        />
      </Sequence>
    );
    off += d;
    return el;
  });

  const capsOut: Cap[] = caps.map((c) => ({ from: Math.round(toOut(c.at) * FPS), to: Math.round(toOut(c.until) * FPS), title: c.title, sub: c.sub, pos: c.pos }));

  return (
    <AbsoluteFill style={{ opacity: Math.min(fadeIn, fadeOut) }}>
      <Backdrop />
      <div style={{ position: "absolute", left: (1920 - W) / 2, top: 14 + enter, width: W, height: H + CHROME, borderRadius: 16, overflow: "hidden", border: `1px solid ${C.line}`, boxShadow: "0 40px 120px rgba(0,0,0,0.7), 0 0 0 1px rgba(255,255,255,0.03)", background: "#0b0b0d" }}>
        <div style={{ height: CHROME, background: "#15151a", borderBottom: `1px solid ${C.line}`, display: "flex", alignItems: "center", padding: "0 14px", gap: 8, fontFamily: FONT }}>
          {["#ff5f57", "#febc2e", "#28c840"].map((c) => (
            <div key={c} style={{ width: 11, height: 11, borderRadius: 11, background: c, opacity: 0.85 }} />
          ))}
          <div style={{ flex: 1, textAlign: "center", color: C.text3, fontSize: 13, letterSpacing: 0.3 }}>{label ?? "Stageflow · operator console"}</div>
          <div style={{ width: 55 }} />
        </div>
        <div style={{ position: "relative", width: W, height: H, overflow: "hidden" }}>
          <div style={{ width: W, height: H, transformOrigin: "50% 50%", transform: `scale(${s}) translate(${-(x - 0.5) * W}px, ${-(y - 0.5) * H}px)` }}>{seqs}</div>
          <Captions caps={capsOut} />
        </div>
      </div>
    </AbsoluteFill>
  );
};
