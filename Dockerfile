FROM node:22.22.1-bookworm-slim@sha256:4f77a690f2f8946ab16fe1e791a3ac0667ae1c3575c3e4d0d4589e9ed5bfaf3d AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV HUSKY=0
WORKDIR /workspace

RUN corepack enable && corepack prepare pnpm@10.30.3 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/api-client/package.json packages/api-client/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/eslint-config/package.json packages/eslint-config/package.json
COPY packages/tsconfig/package.json packages/tsconfig/package.json
COPY packages/ui/package.json packages/ui/package.json
RUN pnpm install --frozen-lockfile

COPY apps/server apps/server
COPY apps/web apps/web
COPY packages packages
COPY scripts scripts
RUN pnpm --filter @remote-control-hub/contracts build \
  && pnpm --filter @remote-control-hub/api-client build \
  && pnpm --filter @remote-control-hub/ui build \
  && pnpm --filter @remote-control-hub/server build \
  && pnpm --filter @remote-control-hub/web build \
  && pnpm --filter @remote-control-hub/server deploy --prod --legacy /opt/server

FROM node:22.22.1-bookworm-slim@sha256:4f77a690f2f8946ab16fe1e791a3ac0667ae1c3575c3e4d0d4589e9ed5bfaf3d

ENV DEPLOYMENT_MODE=standalone
ENV HOST=0.0.0.0
ENV NODE_ENV=production
ENV PORT=3000
ENV SETUP_STATE_FILE=/var/lib/remote-control-hub/setup-state.json
ENV TZ=Asia/Shanghai
ENV WEB_ROOT=/opt/remote-control-hub/web
WORKDIR /opt/remote-control-hub/server

RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates tzdata \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --system --gid 10001 remote-control-hub \
  && useradd --system --uid 10001 --gid remote-control-hub --home-dir /nonexistent --shell /usr/sbin/nologin remote-control-hub \
  && install --directory --owner=remote-control-hub --group=remote-control-hub --mode=0700 /var/lib/remote-control-hub

COPY --from=build --chown=remote-control-hub:remote-control-hub /opt/server ./
COPY --from=build --chown=remote-control-hub:remote-control-hub /workspace/apps/web/dist /opt/remote-control-hub/web

USER remote-control-hub
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:3000/healthz').then(response=>{if(!response.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "dist/index.js"]
