# fx0 self-hosted image (see "Run it with Docker Compose" in README.md).
# Debian, not Alpine: libfx ships prebuilt glibc binaries.
FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci

FROM node:24-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:24-bookworm-slim
WORKDIR /app
# libfx keeps each chat's session in FX_SESSIONS_DIR; attached images go to FX0_ASSETS_DIR.
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0 \
    FX_SESSIONS_DIR=/data/sessions FX0_ASSETS_DIR=/data/assets
COPY --from=build --chown=node:node /app ./
RUN mkdir -p /data/sessions /data/assets && chown -R node:node /data
USER node
VOLUME /data
EXPOSE 3000
CMD ["node_modules/.bin/next", "start"]
