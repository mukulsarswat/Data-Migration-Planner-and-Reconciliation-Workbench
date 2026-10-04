# Migration Workbench: one container serving the API (Node native TS) and the built web shell.
# Runs as root on purpose: Railway volumes mount root-owned at /data.

# 1) All dependencies (dev included) for the web build.
FROM node:26-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: better-sqlite3 ships prebuilt N-API binaries (prebuilds/linux-*.node); skip npm's implicit
# node-gyp rebuild, which would need Python and a C++ toolchain in the slim image.
RUN npm ci --ignore-scripts

# 2) Build the Vite web shell into /app/dist.
FROM deps AS build
COPY . .
RUN npm run build

# 3) Runtime: production deps + server sources (no server build step) + built web assets.
FROM node:26-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production TZ=UTC PORT=8787 DB_PATH=/data/workbench.db STATIC_DIR=/app/dist
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY shared ./shared
COPY server/src ./server/src
RUN mkdir -p /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "server/src/index.ts"]
