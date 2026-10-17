# Stageflow demo video

Everything needed to regenerate the investor/YouTube demo from this checkout.

## How it works

1. **Mock model** (`mock-llm/`): a local OpenAI-compatible server that replies with scripted, deterministic
   output (`mock-llm/script.json`). Stageflow runs real stage and agent sessions against it, so every
   run, gate, approval and trace in the video is produced by the real runtime. No API spend, no secrets.
2. **Demo project** (`acme-ops/`): three pipelines (release notes, vendor research, incident postmortem),
   three tasks and two agents.
3. **Isolated host** (`seed.sh`): copies the project and a fresh `$STAGEFLOW_HOME` to
   `/Users/Shared/stageflow-demo` (no personal paths show in the UI), starts the mock model and
   `sf ui` on port 3900. It never touches `~/.stageflow` or a console on 3847.
4. **Capture** (`capture/`): Playwright records each scene to `out/clips/*.webm`.
5. **Edit** (`src/`): Remotion composes intro, problem, clips with captions and zoom, terminal scene,
   outro, plus a generated music bed (`scripts/make-music.mjs`).

## Regenerate

```bash
npm run build && npm run ui:build        # repo root, once
cd demo-video && npm install
./record-all.sh                          # reseed, record all scenes, copy clips, probe durations
node scripts/make-music.mjs 160          # music bed (public/audio/music.wav)
. ./.env.local                           # HS=<path to a headless Chromium>
npx remotion render src/index.ts Demo out/stageflow-demo.mp4 --codec h264 --crf 16 --browser-executable="$HS"
```

Edit captions, timing and zoom in `src/timeline.ts`. Scene copy lives in `src/TextScenes.tsx`.
