import React from "react";
import { Audio, interpolate, Series, staticFile } from "remotion";
import { ClipScene } from "./ClipScene";
import { Anywhere, Intro, Outro, Problem, Solution } from "./TextScenes";
import { ANYWHERE, CLIPS, clipFrames, INTRO, OUTRO, PROBLEM, SOLUTION, TOTAL } from "./timeline";

const byName = Object.fromEntries(CLIPS.map((c) => [c.clip, c]));
const clip = (name: string) => (
  <Series.Sequence key={name} durationInFrames={clipFrames(byName[name])}>
    <ClipScene {...byName[name]} />
  </Series.Sequence>
);

export const Demo: React.FC = () => (
  <>
    <Audio
      src={staticFile("audio/music.wav")}
      volume={(f) => 0.62 * interpolate(f, [0, 45, TOTAL - 150, TOTAL - 10], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })}
    />
    <Series>
      <Series.Sequence durationInFrames={INTRO}><Intro total={INTRO} /></Series.Sequence>
      <Series.Sequence durationInFrames={PROBLEM}><Problem total={PROBLEM} /></Series.Sequence>
      <Series.Sequence durationInFrames={SOLUTION}><Solution total={SOLUTION} /></Series.Sequence>
      {clip("editor")}
      {clip("liverun")}
      {clip("inspect")}
      {clip("agents")}
      {clip("approval")}
      {clip("webchat")}
      {clip("connect")}
      <Series.Sequence durationInFrames={ANYWHERE}><Anywhere total={ANYWHERE} /></Series.Sequence>
      <Series.Sequence durationInFrames={OUTRO}><Outro total={OUTRO} /></Series.Sequence>
    </Series>
  </>
);
