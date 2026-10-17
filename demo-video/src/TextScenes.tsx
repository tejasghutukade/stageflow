import React from "react";
import { AbsoluteFill, Easing, interpolate, useCurrentFrame } from "remotion";
import { Backdrop } from "./Backdrop";
import { Logo } from "./Logo";
import { C, FONT, MONO } from "./theme";

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
const fade = (f: number, a: number, b: number) => interpolate(f, [a, b], [0, 1], { ...clamp, easing: Easing.out(Easing.cubic) });
const sceneFade = (f: number, total: number) => Math.min(interpolate(f, [0, 10], [0, 1], clamp), interpolate(f, [total - 12, total], [1, 0], clamp));

export const Intro: React.FC<{ total: number }> = ({ total }) => {
  const f = useCurrentFrame();
  return (
    <AbsoluteFill style={{ opacity: sceneFade(f, total), fontFamily: FONT }}>
      <Backdrop />
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", flexDirection: "column" }}>
        <Logo size={150} start={6} />
        <div style={{ marginTop: 34, fontSize: 112, fontWeight: 700, letterSpacing: -3, color: C.text, opacity: fade(f, 34, 54), transform: `translateY(${(1 - fade(f, 34, 54)) * 20}px)` }}>Stageflow</div>
        <div style={{ marginTop: 14, fontSize: 40, color: C.amber, fontWeight: 500, letterSpacing: 0.2, opacity: fade(f, 70, 92) }}>Nothing improvised. Everything staged.</div>
        <div style={{ marginTop: 26, fontSize: 28, color: C.text2, opacity: fade(f, 110, 132) }}>Open-source runtime for configurable multi-stage agent workflows</div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

const BoxRow: React.FC<{ broken: number; glitch: number }> = ({ broken, glitch }) => {
  const f = useCurrentFrame();
  const names = ["research", "draft", "review", "publish"];
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 0, marginTop: 70 }}>
      {names.map((n, i) => (
        <React.Fragment key={n}>
          <div style={{ width: 190, height: 74, borderRadius: 14, border: `1.5px solid ${C.line}`, background: C.panel, color: C.text2, fontSize: 26, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: MONO, opacity: fade(f, 8 + i * 5, 22 + i * 5), transform: `translateX(${Math.sin((f + i * 9) / 3) * glitch * (i % 2 ? 1 : -1)}px)` }}>{n}</div>
          {i < names.length - 1 && (
            <div style={{ width: 110, height: 0, borderTop: `2px ${broken > 0.5 ? "dashed" : "solid"} ${broken > 0.5 ? C.red : C.text3}`, opacity: broken > 0.5 ? 0.55 + 0.45 * Math.abs(Math.sin((f + i * 7) / 4)) : 0.8 }} />
          )}
        </React.Fragment>
      ))}
    </div>
  );
};

export const Problem: React.FC<{ total: number }> = ({ total }) => {
  const f = useCurrentFrame();
  const lines = [
    { t: "Multi-step agent work breaks at the handoffs.", a: 4, b: 72 },
    { t: "One long chat. Copy-pasted context. No contract between steps.", a: 72, b: 150 },
    { t: "And no way to run the same flow on a laptop, in CI and by automation.", a: 150, b: total },
  ];
  return (
    <AbsoluteFill style={{ opacity: sceneFade(f, total), fontFamily: FONT }}>
      <Backdrop glow="rgba(255,107,107,0.06)" />
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", flexDirection: "column" }}>
        <div style={{ height: 150, width: 1500, position: "relative" }}>
          {lines.map((l, i) => {
            const o = Math.min(fade(f, l.a, l.a + 14), interpolate(f, [l.b - 10, l.b], [1, 0], clamp));
            return (
              <div key={i} style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", textAlign: "center", fontSize: 62, fontWeight: 650, letterSpacing: -1.5, color: C.text, lineHeight: 1.15, opacity: o, transform: `translateY(${(1 - o) * 16}px)` }}>{l.t}</div>
            );
          })}
        </div>
        <BoxRow broken={f > 72 ? 1 : 0} glitch={f > 72 && f < 150 ? 2.2 : 0} />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

const NODES = [
  { id: "collect-changes", x: 130, y: 250, kind: "stage" },
  { id: "draft-notes", x: 520, y: 150, kind: "stage" },
  { id: "risk-scan", x: 520, y: 350, kind: "stage" },
  { id: "editor-review", x: 910, y: 250, kind: "gate" },
  { id: "publish-notes", x: 1300, y: 250, kind: "stage" },
];
const EDGES: [number, number][] = [[0, 1], [0, 2], [1, 3], [2, 3], [3, 4]];
const NW = 270, NH = 78;

export const Solution: React.FC<{ total: number }> = ({ total }) => {
  const f = useCurrentFrame();
  const chips = ["Plain YAML in your repo", "A fresh agent session per stage", "Typed envelopes between stages", "Human gates, anywhere"];
  return (
    <AbsoluteFill style={{ opacity: sceneFade(f, total), fontFamily: FONT }}>
      <Backdrop />
      <div style={{ position: "absolute", top: 110, left: 0, right: 0, textAlign: "center", fontSize: 68, fontWeight: 700, letterSpacing: -2, color: C.text, opacity: fade(f, 4, 22) }}>Stages are the unit of composition.</div>
      <div style={{ position: "absolute", left: (1920 - 1700) / 2 + 20, top: 270, width: 1700, height: 480 }}>
        <svg width={1700} height={480} style={{ position: "absolute", inset: 0 }}>
          {EDGES.map(([a, b], i) => {
            const A = NODES[a], B = NODES[b];
            const x1 = A.x + NW, y1 = A.y + NH / 2, x2 = B.x, y2 = B.y + NH / 2;
            const p = interpolate(f, [28 + i * 6, 46 + i * 6], [0, 1], clamp);
            const d = `M ${x1} ${y1} C ${x1 + 70} ${y1}, ${x2 - 70} ${y2}, ${x2} ${y2}`;
            return <path key={i} d={d} stroke={C.text3} strokeWidth={2} fill="none" pathLength={1} strokeDasharray={1} strokeDashoffset={1 - p} />;
          })}
        </svg>
        {NODES.map((n, i) => {
          const o = fade(f, 14 + i * 5, 30 + i * 5);
          const gate = n.kind === "gate";
          return (
            <div key={n.id} style={{ position: "absolute", left: n.x, top: n.y, width: NW, height: NH, borderRadius: 16, background: C.panel, border: `1.5px solid ${gate ? C.amber : C.line}`, boxShadow: gate ? "0 0 40px rgba(245,183,59,0.15)" : "none", display: "flex", alignItems: "center", justifyContent: "center", gap: 12, color: C.text, fontFamily: MONO, fontSize: 25, opacity: o, transform: `scale(${0.92 + 0.08 * o})` }}>
              <span style={{ width: 11, height: 11, borderRadius: 11, background: gate ? C.amber : C.green }} />
              {n.id}
              {gate && <span style={{ position: "absolute", top: -14, right: 14, fontSize: 15, background: C.amber, color: "#111", borderRadius: 8, padding: "2px 9px", fontFamily: FONT, fontWeight: 700 }}>HUMAN GATE</span>}
            </div>
          );
        })}
        <Envelopes f={f} />
      </div>
      <div style={{ position: "absolute", bottom: 100, left: 0, right: 0, display: "flex", justifyContent: "center", gap: 22 }}>
        {chips.map((c, i) => {
          const o = fade(f, 70 + i * 22, 90 + i * 22);
          return (
            <div key={c} style={{ fontSize: 28, color: C.text, background: C.panel, border: `1px solid ${C.line}`, borderRadius: 999, padding: "14px 26px", opacity: o, transform: `translateY(${(1 - o) * 14}px)` }}>{c}</div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

const Envelopes: React.FC<{ f: number }> = ({ f }) => {
  // Small "envelope" pills travelling the edges, one hop at a time.
  const hops: { e: [number, number]; start: number }[] = [
    { e: [0, 1], start: 62 }, { e: [0, 2], start: 62 }, { e: [1, 3], start: 100 }, { e: [2, 3], start: 100 }, { e: [3, 4], start: 150 },
  ];
  return (
    <>
      {hops.map((h, i) => {
        const A = NODES[h.e[0]], B = NODES[h.e[1]];
        const p = interpolate(f, [h.start, h.start + 26], [0, 1], { ...clamp, easing: Easing.inOut(Easing.cubic) });
        if (f < h.start || f > h.start + 34) return null;
        const x = A.x + NW + (B.x - (A.x + NW)) * p - 36, y = A.y + NH / 2 + (B.y - A.y) * p - 15;
        return (
          <div key={i} style={{ position: "absolute", left: x, top: y, fontFamily: MONO, fontSize: 15, color: "#0a0a0c", background: C.green, borderRadius: 8, padding: "5px 10px", opacity: Math.min(1, (34 - (f - h.start)) / 8) }}>envelope</div>
        );
      })}
    </>
  );
};

type Line = { text: string; kind: "cmd" | "out"; color?: string };
const TERM: Line[] = [
  { kind: "cmd", text: "sf validate --strict" },
  { kind: "out", text: "Validation passed.", color: C.green },
  { kind: "cmd", text: "sf graph --pipeline pipelines/release-notes.pipeline.yaml" },
  { kind: "out", text: "▶ collect-changes   entry" },
  { kind: "out", text: "   ├─▶ draft-notes" },
  { kind: "out", text: "   └─▶ risk-scan" },
  { kind: "out", text: "  draft-notes ▸ editor-review ▸ publish-notes" },
  { kind: "cmd", text: "sf run --pipeline pipelines/incident-postmortem.pipeline.yaml \\" },
  { kind: "cmd", text: "  --task tasks/checkout-outage.task.yaml --json" },
  { kind: "out", text: "{" },
  { kind: "out", text: '  "ok": true,', color: C.green },
  { kind: "out", text: '  "outcome": "succeeded",', color: C.green },
  { kind: "out", text: '  "runId": "2026-10-16T21-14-24-835Z-a8a7d1"' },
  { kind: "out", text: "}" },
  { kind: "cmd", text: "echo $?" },
  { kind: "out", text: "0", color: C.green },
];

export const Anywhere: React.FC<{ total: number }> = ({ total }) => {
  const f = useCurrentFrame();
  // Reveal: commands type out char by char, outputs appear instantly after their command.
  let t = 14;
  const rows = TERM.map((l) => {
    const start = t;
    if (l.kind === "cmd") t += Math.ceil(l.text.length * 0.9) + 8;
    else t += 3;
    return { ...l, start };
  });
  const cardsAt = 40;
  const cards = [
    { k: "Locally", v: "sf ui", d: "Operator console for triage, gates and approvals", c: C.blue },
    { k: "In CI", v: "sf run --json", d: "Exit 0 succeeded · 1 failed · 2 waiting on a human", c: C.green },
    { k: "From other tools", v: "MCP at /mcp", d: "Agents and IDEs drive the same pipelines", c: C.amber },
  ];
  return (
    <AbsoluteFill style={{ opacity: sceneFade(f, total), fontFamily: FONT }}>
      <Backdrop glow="rgba(106,166,255,0.06)" />
      <div style={{ position: "absolute", top: 70, left: 0, right: 0, textAlign: "center", fontSize: 62, fontWeight: 700, letterSpacing: -2, color: C.text, opacity: fade(f, 2, 18) }}>One pipeline. Run it anywhere.</div>
      <div style={{ position: "absolute", left: 90, top: 190, width: 1060, height: 800, borderRadius: 16, background: "#0c0c10", border: `1px solid ${C.line}`, boxShadow: "0 40px 100px rgba(0,0,0,0.6)", overflow: "hidden", opacity: fade(f, 4, 20) }}>
        <div style={{ height: 40, background: "#15151a", borderBottom: `1px solid ${C.line}`, display: "flex", alignItems: "center", padding: "0 16px", gap: 8 }}>
          {["#ff5f57", "#febc2e", "#28c840"].map((c) => <div key={c} style={{ width: 12, height: 12, borderRadius: 12, background: c, opacity: 0.85 }} />)}
          <div style={{ flex: 1, textAlign: "center", color: C.text3, fontSize: 14 }}>acme-ops — zsh</div>
        </div>
        <div style={{ padding: "22px 28px", fontFamily: MONO, fontSize: 25, lineHeight: 1.5, color: C.text }}>
          {rows.map((r, i) => {
            if (f < r.start) return null;
            if (r.kind === "out") return <div key={i} style={{ color: r.color ?? C.text2, whiteSpace: "pre" }}>{r.text}</div>;
            const n = Math.min(r.text.length, Math.floor((f - r.start) / 0.9));
            return (
              <div key={i} style={{ whiteSpace: "pre" }}>
                <span style={{ color: C.amber }}>{r.text.startsWith(" ") ? "  " : "$ "}</span>
                {r.text.slice(0, n)}
                {n < r.text.length && <span style={{ background: C.text, color: C.bg }}> </span>}
              </div>
            );
          })}
        </div>
      </div>
      <div style={{ position: "absolute", left: 1210, top: 190, width: 620, display: "flex", flexDirection: "column", gap: 26 }}>
        {cards.map((c, i) => {
          const o = fade(f, cardsAt + i * 26, cardsAt + 18 + i * 26);
          return (
            <div key={c.k} style={{ background: C.panel, border: `1px solid ${C.line}`, borderLeft: `4px solid ${c.c}`, borderRadius: 14, padding: "24px 28px", opacity: o, transform: `translateX(${(1 - o) * 30}px)` }}>
              <div style={{ fontSize: 22, color: C.text3, letterSpacing: 1.2, textTransform: "uppercase" }}>{c.k}</div>
              <div style={{ fontSize: 40, fontWeight: 650, color: C.text, marginTop: 6, fontFamily: MONO }}>{c.v}</div>
              <div style={{ fontSize: 24, color: C.text2, marginTop: 10, lineHeight: 1.35 }}>{c.d}</div>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

export const Outro: React.FC<{ total: number }> = ({ total }) => {
  const f = useCurrentFrame();
  return (
    <AbsoluteFill style={{ opacity: Math.min(interpolate(f, [0, 12], [0, 1], clamp), interpolate(f, [total - 24, total], [1, 0], clamp)), fontFamily: FONT }}>
      <Backdrop />
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", flexDirection: "column" }}>
        <Logo size={120} start={4} />
        <div style={{ marginTop: 26, fontSize: 92, fontWeight: 700, letterSpacing: -2.5, color: C.text, opacity: fade(f, 24, 42) }}>Stageflow</div>
        <div style={{ marginTop: 14, fontSize: 38, color: C.text2, opacity: fade(f, 44, 62) }}>Configurable multi-stage agent workflows.</div>
        <div style={{ marginTop: 44, display: "flex", gap: 18, opacity: fade(f, 70, 92) }}>
          {["Open source", "MIT licensed", "Local-first"].map((t) => (
            <div key={t} style={{ fontSize: 28, color: C.text, border: `1px solid ${C.line}`, background: C.panel, borderRadius: 999, padding: "10px 24px" }}>{t}</div>
          ))}
        </div>
        <div style={{ marginTop: 44, fontSize: 38, color: C.amber, fontFamily: MONO, opacity: fade(f, 100, 122) }}>stage-flow.dev</div>
        <div style={{ marginTop: 10, fontSize: 28, color: C.text3, fontFamily: MONO, opacity: fade(f, 108, 130) }}>github.com/tejasghutukade/stageflow</div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
