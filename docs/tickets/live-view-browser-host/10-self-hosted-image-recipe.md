# 10: Self-hosted image recipe

**What to build:** A documented image recipe for a self-hosted Linux or Docker Host that includes Chromium and Xvfb, plus the Docker guide section explaining launch options, the no-sandbox note, and why no container runtime socket is mounted. An opt-in Docker smoke shows a human login stage working on a Host with no screen.

**Blocked by:** 09, 06

**Status:** done

- [x] The recipe builds and runs; with it a human login stage no longer fails with the no-screen error.
- [x] The Docker guide documents the browser dependencies, the Host launch options, ARM Linux's distribution Chromium path, and the rule against mounting a runtime socket.
- [x] An opt-in smoke (gated by an environment variable) runs the fixture login through the live view in the image and passes.
- [x] The recipe adds no secrets and runs as a non-root user.

## Notes (from the implementation and verification)

- The recipe extends the runtime image; the published image is unchanged. Host config is a copyable file bind-mounted at `/data/config.yaml` (the Host rejects unknown `STAGEFLOW_*` env and ignores `AGENT_BROWSER_*`).
- The Docker smoke passed (re-run independently); no images, containers or volumes of the smoke remain.
- Unverified: whether `requires: agent-browser` preflight passes inside the image. The toolchain manifest does not list agent-browser; the preflight code falls back to resolving the tool on `PATH`, so it should pass, but it was not run in the image.
- The subagent recommends `--shm-size=1g` for Chromium in containers; this is not from the spikes.
