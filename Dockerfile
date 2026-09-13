# Generic stage-attempt sandbox image (docs/plans/stage-container-sandbox-spec.md).
#
# Runs one Stageflow stage attempt per container: `docker run --rm -v
# <rootDir>:<rootDir> -w <rootDir> stageflow-agent:v1 internal run-stage
# ...`. The project root is mounted at the *same absolute path* inside the
# container as on the host (not a fixed /workspace) — the run store keeps
# absolute host paths (e.g. the pipeline/task file location) that the
# worker resolves verbatim, so the mount point has to match. Nothing about
# the target repo is baked into this image.
#
# Credentials (ANTHROPIC_API_KEY, GH_TOKEN/GITHUB_TOKEN) are forwarded by
# the launcher via `-e NAME` (bare form) at run time, not baked in here.

FROM node:22-bookworm-slim AS build
# python3/make/g++: node-gyp needs these to compile native deps (e.g.
# better-sqlite3) when no prebuilt binary matches this image's platform.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
RUN npm ci && npm run build

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      git curl ca-certificates gnupg python3 make g++ \
    && mkdir -p -m 755 /etc/apt/keyrings \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh

WORKDIR /app
COPY package.json package-lock.json ./
# python3/make/g++ (installed above) cover native deps (e.g. better-sqlite3)
# that lack a prebuilt binary for this image's platform; purged afterward.
RUN npm ci --omit=dev \
    && apt-get purge -y --auto-remove python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/dist ./dist

# No WORKDIR here: the launcher always passes -w <rootDir> at `docker run`
# time (see comment at the top of this file), which overrides any default.
ENTRYPOINT ["node", "/app/dist/cli.js"]
