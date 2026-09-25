# syntax=docker/dockerfile:1

ARG NODE_IMAGE=node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c

FROM ${NODE_IMAGE} AS build
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY package.json package-lock.json ./
COPY ui/package.json ./ui/
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY ui ./ui
COPY scripts ./scripts
COPY skills ./skills
COPY examples ./examples
COPY README.md LICENSE ./
RUN npm run build \
  && npm run ui:build \
  && npm prune --omit=dev \
  && npm cache clean --force

FROM ${NODE_IMAGE} AS runtime
ARG STAGEFLOW_BUILD_SHA=unknown
RUN apt-get update \
  && apt-get install -y --no-install-recommends git bash tini ca-certificates curl \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --gid 10001 stageflow \
  && useradd --uid 10001 --gid 10001 --home-dir /data --create-home --shell /usr/sbin/nologin stageflow \
  && mkdir -p /data/tmp /etc/stageflow /opt/stageflow \
  && chown stageflow:stageflow /data /data/tmp

WORKDIR /opt/stageflow
COPY --from=build --chown=stageflow:stageflow /src/package.json /src/package-lock.json ./
COPY --from=build --chown=stageflow:stageflow /src/node_modules ./node_modules
COPY --from=build --chown=stageflow:stageflow /src/dist ./dist
COPY --from=build --chown=stageflow:stageflow /src/skills ./skills
COPY --from=build --chown=stageflow:stageflow /src/examples ./examples
COPY --from=build --chown=stageflow:stageflow /src/README.md /src/LICENSE ./
COPY --from=build /src/scripts/generate-toolchain-manifest.mjs ./scripts/generate-toolchain-manifest.mjs
RUN node ./scripts/generate-toolchain-manifest.mjs /etc/stageflow/toolchain.json \
  && rm -rf ./scripts \
  && ln -sf /opt/stageflow/dist/cli.js /usr/local/bin/sf \
  && ln -sf /opt/stageflow/dist/cli.js /usr/local/bin/stageflow \
  && chmod 755 /opt/stageflow/dist/cli.js

ENV STAGEFLOW_HOME=/data \
  STAGEFLOW_BIND=0.0.0.0 \
  STAGEFLOW_NO_AUTOSTART=1 \
  STAGEFLOW_NO_OPEN=1 \
  TMPDIR=/data/tmp \
  SQLITE_TMPDIR=/data/tmp \
  STAGEFLOW_BUILD_SHA=${STAGEFLOW_BUILD_SHA} \
  NODE_ENV=production

VOLUME ["/data"]
EXPOSE 3847

USER stageflow:stageflow

HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3847/livez || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sf", "mcp"]
