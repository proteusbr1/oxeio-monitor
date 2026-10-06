# ── deps ────────────────────────────────────────────────────────────────────
FROM node:24-alpine AS deps
WORKDIR /app
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci && npx prisma generate

# ── build ───────────────────────────────────────────────────────────────────
FROM node:24-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate && npm run build

# ── runtime ─────────────────────────────────────────────────────────────────
FROM node:24-alpine AS runtime
ENV NODE_ENV=production
ENV TZ=Asia/Dhaka

# Same version as the web: `/health` returns it, and the dashboard compares the two.
# Careful: otherwise a half deploy (new web, old api) would be completely silent, and
# answering "I put the fix in, why is it not working" would cost hours.
ARG APP_BUILD=dev
ARG APP_COMMIT=local
ENV APP_BUILD=$APP_BUILD
ENV APP_COMMIT=$APP_COMMIT
WORKDIR /app

# `postgresql16-client`: `pg_dump` for the nightly backup (K02).
#
# Careful: without it the backup NEVER ran even once, and the failure was almost
# silent: the alert was raised, but among 46 open alerts nobody singled out
# "The nightly backup failed" (found on 15 August).
#
# Careful: the MAJOR version must match. The server is Postgres 16, so the client is
# too. An older `pg_dump` flatly refuses a newer server ("server version mismatch"),
# and the failure would come back every night.
#
# The alternative was to expose the host's docker socket to the api container
# (`BACKUP_DOCKER_CONTAINER`). Not taken: that is effectively root on the host, while
# all that is needed here is a client binary (~2 MB) that can dump over the network.
RUN apk add --no-cache tzdata dumb-init postgresql16-client

COPY package*.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev && npm cache clean --force

# generated prisma client + query engine (the prisma CLI is not in the prod deps)
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/dist ./dist

# Screenshots and nightly dumps are mounted here; the node user needs write access.
#
# Careful: this image `chown` does NOT help on a bind mount: the host folder's
# ownership wins (the whole story is in `deploy/README.md § ১০.৪`). It only applies to
# named volumes and to folders created for the first time.
#
# Careful: `/data/backups` fell into exactly this trap (15 August): docker created the
# folder owned by root, and the api runs as uid 1000, hence `EACCES`. The same thing had
# happened with storage earlier, so both are here, side by side, so the next person
# does not forget one.
RUN mkdir -p /data/storage /data/backups \
 && chown -R node:node /data/storage /data/backups
USER node

EXPOSE 3000
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/main.js"]
