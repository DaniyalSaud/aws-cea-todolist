FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
RUN npm ci --workspace frontend --include-workspace-root=false
COPY frontend/ frontend/
ARG VITE_API_URL=""
ENV VITE_API_URL=${VITE_API_URL}
RUN npm run build --workspace frontend

FROM nginxinc/nginx-unprivileged:1.28-alpine
ENV API_UPSTREAM=backend:3001 DNS_RESOLVER=127.0.0.11 NGINX_ENVSUBST_FILTER="^(API_UPSTREAM|DNS_RESOLVER)$"
COPY frontend/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/frontend/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
