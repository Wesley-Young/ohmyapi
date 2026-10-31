FROM node:26.3.0-bookworm-slim AS build

WORKDIR /app
ENV CI=true

RUN npm install --global pnpm@12.4.2
COPY . .
RUN pnpm install --frozen-lockfile --prod=false
RUN pnpm typecheck
RUN pnpm build

FROM node:26.3.0-bookworm-slim AS runtime

ARG VCS_REF=unknown
LABEL org.opencontainers.image.revision=$VCS_REF

WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8000
COPY --from=build --chown=node:node /app /app
USER node
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=3s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || '8000') + '/api/ready', { signal: AbortSignal.timeout(2000) }).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

CMD ["node", "--conditions=@ohmyapi/source", "scripts/start.mjs"]
