FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
RUN npm ci --workspace backend --include-workspace-root=false
COPY backend/ backend/
COPY scripts/download-rds-ca.mjs scripts/download-rds-ca.mjs
RUN npm run build --workspace backend
RUN node scripts/download-rds-ca.mjs
RUN npm prune --omit=dev --workspace backend --include-workspace-root=false
RUN mkdir -p /app/backend/uploads

FROM node:24-bookworm-slim
ENV NODE_ENV=production PORT=3001 DB_SSL=true DB_SSL_CA_PATH=/app/certs/global-bundle.pem
WORKDIR /app/backend
COPY --from=build --chown=node:node /app/node_modules /app/node_modules
COPY --from=build --chown=node:node /app/backend/dist ./dist
COPY --from=build --chown=node:node /app/backend/migrations ./migrations
COPY --from=build --chown=node:node /app/backend/uploads ./uploads
COPY --from=build --chown=node:node /app/certs /app/certs
COPY --chown=node:node backend/package.json ./package.json
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=7s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:3001/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
