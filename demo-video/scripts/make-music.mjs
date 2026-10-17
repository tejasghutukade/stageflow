// Original arranged music bed (no samples, no licensing). Sections follow the video's scene changes.
import fs from "node:fs";
const SR = 44100, DUR = Number(process.argv[2] ?? 143);
const BPM = 240 / (21 / 8); // bar = 2.625s so the drop lands exactly on 21s (editor scene)
const beat = 60 / BPM, bar = beat * 4;
const N = Math.floor(SR * DUR);
const L = new Float32Array(N), R = new Float32Array(N), DL = new Float32Array(N), DR = new Float32Array(N);
const note = (m) => 440 * 2 ** ((m - 69) / 12);
let seed = 11; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const sm = (a, b, t) => Math.min(1, Math.max(0, (t - a) / (b - a)));
// energy sections (seconds): [start, end, level 0..1]
const lvl = (t) => {
  if (t < 6) return 0.4 + 0.1 * sm(0, 6, t);
  if (t < 13.5) return 0.5;
  if (t < 21) return 0.5 + 0.5 * sm(13.5, 21, t);
  if (t < 104) return 1.0;
  if (t < 122) return 0.75;
  if (t < 134) return 0.5;
  return 0.35;
};
const has = { kick: (t) => t >= 21 && t < 122.2 || (t >= 122 && t < 134 && false), snare: (t) => t >= 33.3 && t < 122, hat: (t) => t >= 33.3 && t < 130, bass: (t) => t >= 21 && t < 134, arp: (t) => t >= 6 && t < 136, riser: (t) => t >= 15 && t < 21 };
const chords = [ [57, 60, 64, 67], [53, 57, 60, 64], [48, 55, 60, 64], [55, 59, 62, 67], [50, 57, 60, 65], [53, 57, 60, 64], [48, 55, 60, 64], [52, 56, 59, 64] ]; // Am F C G Dm F C E
const chordAt = (t) => chords[Math.floor(t / bar / 2) % chords.length];
function add(buf, t0, dur, fn, g) { const i0 = Math.floor(t0 * SR), n = Math.floor(dur * SR); for (let i = 0; i < n && i0 + i < N; i++) buf[i0 + i] += fn(i / SR, i / n) * g; }
// Pads
for (let c = 0; c * bar * 2 < DUR; c++) {
  const t = c * bar * 2, ch = chords[c % chords.length];
  for (const [vi, m] of ch.entries()) for (const det of [-0.1, 0.1]) {
    const f = note(m + 12) * 2 ** (det / 12), buf = det < 0 ? L : R;
    add(buf, t, bar * 2 + 1.4, (x) => { const env = Math.min(1, x / 1.2) * Math.min(1, (bar * 2 + 1.4 - x) / 1.4); return (Math.sin(2 * Math.PI * f * x) + 0.3 * Math.sin(4 * Math.PI * f * x)) * env * (0.6 + 0.4 * Math.sin(x * 0.7 + vi)); }, 0.03 * (0.5 + 0.6 * lvl(t + 1)));
  }
}
// Bass (eighths, root/octave), kick, snare, hats, arp
const kickAt = (t, g) => add(L, t, 0.35, (x) => Math.sin(2 * Math.PI * (48 + 90 * Math.exp(-x * 28)) * x) * Math.exp(-x * 9), g) || add(R, t, 0.35, (x) => Math.sin(2 * Math.PI * (48 + 90 * Math.exp(-x * 28)) * x) * Math.exp(-x * 9), g);
const noise = (len, g, buf, t, hp, dec) => { let prev = 0; add(buf, t, len, (x) => { const n = rnd() * 2 - 1; const out = n - prev * hp; prev = n; return out * Math.exp(-x * dec); }, g); };
const duck = new Float32Array(N).fill(1); // sidechain-ish ducking for pad/arp
for (let t = 0, k = 0; t < DUR; t += beat / 2, k++) {
  const step = k % 8, ch = chordAt(t), root = ch[0] - 24;
  if (has.bass(t)) { const m = step % 2 ? root + 12 : root; add(L, t, beat / 2 * 0.95, (x) => (Math.sin(2 * Math.PI * note(m) * x) + 0.25 * Math.sin(4 * Math.PI * note(m) * x)) * Math.min(1, x / 0.01) * Math.exp(-x * 3), 0.13); add(R, t, beat / 2 * 0.95, (x) => (Math.sin(2 * Math.PI * note(m) * x) + 0.25 * Math.sin(4 * Math.PI * note(m) * x)) * Math.min(1, x / 0.01) * Math.exp(-x * 3), 0.13); }
  if (step % 2 === 0 && has.kick(t) && !(t >= 122 && t < 134)) { kickAt(t, 0.42 * (t < 33.3 ? 0.8 : 1)); const i0 = Math.floor(t * SR); for (let i = 0; i < SR * 0.2 && i0 + i < N; i++) duck[i0 + i] = Math.min(duck[i0 + i], 0.55 + 0.45 * (i / (SR * 0.2))); }
  if ((step === 2 || step === 6) && has.snare(t)) { noise(0.22, 0.09, L, t, 0.4, 14); noise(0.22, 0.09, R, t, 0.4, 14); add(L, t, 0.15, (x) => Math.sin(2 * Math.PI * 190 * x) * Math.exp(-x * 25), 0.1); add(R, t, 0.15, (x) => Math.sin(2 * Math.PI * 190 * x) * Math.exp(-x * 25), 0.1); }
  if (has.hat(t) && step % 1 === 0) { const open = step % 4 === 3; noise(open ? 0.14 : 0.04, open ? 0.035 : 0.028, k % 2 ? L : R, t, 0.95, open ? 22 : 80); }
}
// Arp plucks (8ths, 16ths once drums are in)
const pat = [0, 2, 3, 1, 2, 3, 1, 2];
for (let t = 6, k = 0; t < 136; t += (t >= 33.3 && t < 122 ? beat / 4 : beat / 2), k++) {
  if (!has.arp(t)) continue;
  const ch = chordAt(t), m = ch[pat[k % pat.length]] + 24 + (Math.floor(t / bar) % 4 === 3 && k % 4 === 0 ? 12 : 0), f = note(m), pan = 0.25 + 0.5 * ((k * 7) % 8) / 8;
  const vol = (0.4 + 0.6 * lvl(t)) * sm(6, 14, t) * (t > 130 ? Math.max(0, (136 - t) / 6) : 1);
  const fn = (x) => (Math.sin(2 * Math.PI * f * x) + 0.45 * Math.sin(4 * Math.PI * f * x) * Math.exp(-x * 7) + 0.15 * Math.sin(6 * Math.PI * f * x) * Math.exp(-x * 14)) * Math.exp(-x * 5.5) * Math.min(1, x / 0.003);
  const g = 0.07 * vol;
  add(L, t, 1.2, fn, g * (1 - pan)); add(R, t, 1.2, fn, g * pan);
  add(DL, t + beat * 0.75, 1.2, fn, g * 0.35 * (1 - pan)); add(DR, t + beat * 0.75, 1.2, fn, g * 0.35 * pan); // dotted echo
}
// Riser into the drop
add(L, 15, 6, (x, p) => (rnd() * 2 - 1) * p * p, 0.05); add(R, 15, 6, (x, p) => (rnd() * 2 - 1) * p * p, 0.05);
add(L, 15, 6.05, (x, p) => Math.sin(2 * Math.PI * (200 + 1400 * p * p) * x) * p, 0.02); add(R, 15, 6.05, (x, p) => Math.sin(2 * Math.PI * (200 + 1400 * p * p) * x) * p, 0.02);
add(L, 20.7, 1.6, (x) => (rnd() * 2 - 1) * Math.exp(-x * 3), 0.07); add(R, 20.7, 1.6, (x) => (rnd() * 2 - 1) * Math.exp(-x * 3), 0.07); // crash at drop
// Outro: resolving bell chord at 134
for (const [i, m] of [69, 72, 76, 81].entries()) { const f = note(m); const fn = (x) => (Math.sin(2 * Math.PI * f * x) + 0.3 * Math.sin(2 * Math.PI * 2.76 * f * x) * Math.exp(-x * 6)) * Math.exp(-x * 0.9) * Math.min(1, x / 0.004); add(L, 134 + i * 0.18, 6, fn, 0.06); add(R, 134 + i * 0.18, 6, fn, 0.06); }
// Reverb (parallel combs) on a send of the bus, applied to everything
function comb(buf, d, fb) { const n = Math.floor(d * SR), out = new Float32Array(N); for (let i = 0; i < N; i++) out[i] = buf[i] + (i >= n ? out[i - n] * fb : 0); return out; }
const mix = (a, b) => { const o = new Float32Array(N); for (let i = 0; i < N; i++) o[i] = a[i] + b[i]; return o; };
const dryL = mix(L, DL), dryR = mix(R, DR);
for (let i = 0; i < N; i++) { const d = i / SR > 21 ? duck[i] : 1; dryL[i] *= 0.6 + 0.4 * d; dryR[i] *= 0.6 + 0.4 * d; }
const wl = [0.0297, 0.0371, 0.0411, 0.0437].map((d, i) => comb(dryL, d, 0.64 - i * 0.02)), wr = [0.0311, 0.0353, 0.0397, 0.0451].map((d, i) => comb(dryR, d, 0.64 - i * 0.02));
const outL = new Float32Array(N), outR = new Float32Array(N); let peak = 0;
for (let i = 0; i < N; i++) {
  const t = i / SR, fade = Math.min(1, t / 2.5) * Math.min(1, (DUR - t) / 5);
  const l = (dryL[i] + (wl[0][i] + wl[1][i] + wl[2][i] + wl[3][i]) * 0.07) * fade, r = (dryR[i] + (wr[0][i] + wr[1][i] + wr[2][i] + wr[3][i]) * 0.07) * fade;
  outL[i] = Math.tanh(l * 1.8); outR[i] = Math.tanh(r * 1.8); peak = Math.max(peak, Math.abs(outL[i]), Math.abs(outR[i]));
}
const k = 0.8 / peak, buf = Buffer.alloc(N * 4);
for (let i = 0; i < N; i++) { buf.writeInt16LE(Math.round(outL[i] * k * 32767), i * 4); buf.writeInt16LE(Math.round(outR[i] * k * 32767), i * 4 + 2); }
const h = Buffer.alloc(44); h.write("RIFF", 0); h.writeUInt32LE(36 + buf.length, 4); h.write("WAVEfmt ", 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(2, 22); h.writeUInt32LE(SR, 24); h.writeUInt32LE(SR * 4, 28); h.writeUInt16LE(4, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(buf.length, 40);
fs.writeFileSync("public/audio/music.wav", Buffer.concat([h, buf]));
console.log("wrote music.wav", DUR + "s @", BPM.toFixed(1), "bpm");
