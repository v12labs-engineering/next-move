FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM dependencies AS build
COPY . .
COPY deploy/local/restore-route.ts.fixture app/api/local-restore-test/route.ts
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ENV NEXT_TELEMETRY_DISABLED=1
RUN node scripts/build-boat-worker.mjs && ./node_modules/.bin/next build --webpack

FROM rust:1.100.0-alpine3.22 AS firecrawl_build
RUN apk add --no-cache build-base git linux-headers
# Pin the source used for the registry Map integration.
RUN git init /firecrawl \
  && git -C /firecrawl remote add origin https://github.com/firecrawl/firecrawl.git \
  && git -C /firecrawl sparse-checkout set apps/local apps/api/native \
  && git -C /firecrawl fetch --depth 1 origin 1510bc4fff9c7014f6fa5be0f821ece168a69d13 \
  && git -C /firecrawl checkout --detach FETCH_HEAD
WORKDIR /firecrawl/apps/local
RUN CARGO_NET_GIT_FETCH_WITH_CLI=true CARGO_PROFILE_RELEASE_LTO=false \
  CARGO_PROFILE_RELEASE_CODEGEN_UNITS=16 CARGO_PROFILE_RELEASE_OPT_LEVEL=1 \
  cargo build --locked --release

FROM node:24-alpine3.22 AS catalog_scheduler
WORKDIR /app
RUN apk add --no-cache postgresql17-client chromium
# Firecrawl Local renders JavaScript-built job pages with this Chromium.
ENV FIRECRAWL_CHROME_PATH=/usr/bin/chromium-browser
COPY --from=firecrawl_build /firecrawl/apps/local/target/release/firecrawl-local /usr/local/bin/firecrawl-local
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY lib ./lib
COPY scripts ./scripts

FROM dependencies AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
COPY --from=build --chown=node:node /app/.next ./.next
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/skills/resume-preparation ./skills/resume-preparation
COPY --from=build --chown=node:node \
  /app/workers/browser-use/agent.py \
  /app/workers/browser-use/server.py \
  /app/workers/browser-use/tool_models.py \
  /app/workers/browser-use/boat_server.py \
  /app/workers/browser-use/requirements.txt \
  /app/workers/browser-use/captcha-worker.mjs \
  ./workers/browser-use/
COPY deploy/local/app-watchdog.mjs ./app-watchdog.mjs
USER node
CMD ["node", "app-watchdog.mjs"]
