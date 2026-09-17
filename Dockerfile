# Sandbox image for Bash-in-a-Box (docs/specs/stage-container-sandbox.md, V2).
#
# This container's own process never runs Stageflow code — it only ever
# receives `docker exec bash -c "<command>"` calls from the host-side stage
# worker, which routes the agent's `Bash` tool calls here via the Claude
# Agent SDK's `toolAliases`. So no Stageflow `dist/`/`node_modules` is
# baked in, no build stage, no ANTHROPIC_API_KEY ever reaches this image —
# just the tools a target repo's own shell commands are likely to need:
# git, gh, and common language runtimes (node, python3).
#
# Started long-lived per stage attempt (`docker run -d ... sleep infinity`)
# and `exec`'d into repeatedly, then removed when the attempt ends. The
# project root is mounted at the *same absolute path* inside the container
# as on the host (not a fixed /workspace) — see the launcher/worker code
# that starts this container for why.

FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      git curl ca-certificates gnupg python3 make g++ \
    && mkdir -p -m 755 /etc/apt/keyrings \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# No WORKDIR: the worker always passes -w <rootDir> at `docker run` time,
# matching the mount, which overrides any default.
