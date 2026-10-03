# Web do oXeio para o Coolify (contexto = raiz do repo).
# Igual a oxeio-monitor/web/Dockerfile, so troca o Caddyfile pelo coolify/Caddyfile
# (atras do Traefik). Se o Dockerfile do upstream mudar, refletir aqui.
FROM node:24-alpine AS build
WORKDIR /app
COPY oxeio-monitor/web/package*.json ./
RUN npm ci
COPY oxeio-monitor/web/ .
ARG APP_BUILD=dev
ARG APP_COMMIT=local
ARG APP_BUILT_AT=
ENV VITE_APP_BUILD=$APP_BUILD
ENV VITE_APP_COMMIT=$APP_COMMIT
ENV VITE_APP_BUILT_AT=$APP_BUILT_AT
RUN npm run build

FROM caddy:2-builder-alpine AS caddy-build
RUN xcaddy build \
      --with github.com/mholt/caddy-ratelimit@v0.1.0

FROM caddy:2-alpine AS runtime
COPY --from=caddy-build /usr/bin/caddy /usr/bin/caddy
ENV TZ=Asia/Dhaka
RUN apk add --no-cache tzdata
COPY --from=build /app/dist /srv
COPY coolify/Caddyfile /etc/caddy/Caddyfile
RUN caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
EXPOSE 8080
