# Image that serves the dashboard in production.
#
# Careful: this did not exist until now. `docker compose up -d` only brought up
#    postgres and the api, and the only way to run the dashboard was to keep
#    `npm run dev` (Vite's dev server) running by hand. So when the server PC rebooted
#    the owner could see no page until someone opened a terminal and ran the command
#    again.

# ── build ───────────────────────────────────────────────────────────────────
FROM node:24-alpine AS build
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

# ── Version ──────────────────────────────────────────────────────────────────
# The number is NOT written by hand, it comes from git, and that is the whole point.
#    If it had to be bumped by hand, one day someone would forget, and the version on
#    screen would LIE: the owner would think new code is running when it is the old one.
#    Careful: a wrong version is worse than no version.
#
# Careful: the defaults are `dev`/`local`: if someone builds without git (or without
#    `vps-update.sh`) the image is still built, it just honestly says "dev".
ARG APP_BUILD=dev
ARG APP_COMMIT=local
ARG APP_BUILT_AT=

ENV VITE_APP_BUILD=$APP_BUILD
ENV VITE_APP_COMMIT=$APP_COMMIT
ENV VITE_APP_BUILT_AT=$APP_BUILT_AT

# Careful: `npm run build` = `tsc -b && vite build`: if types are broken the image is
#    not built at all. Deliberate: better a stopped build than a broken dashboard
#    being deployed.
RUN npm run build

# ── Caddy + rate-limit plugin ───────────────────────────────────────────────
# R6 / G116: Caddy has NO built-in rate limit, a plugin is needed.
#    So the binary is rebuilt with `xcaddy`.
#
# Careful: this step adds ~1-2 minutes to the build and NEEDS THE NETWORK (it downloads
#    the plugin). What it buys: a login flood is stopped BEFORE it reaches the app. The
#    app's own throttle (`login-throttle.service.ts`) COUNTS wrong passwords, but every
#    attempt still enters NestJS, looks the user up in the DB and runs bcrypt, which
#    costs CPU. The two layers stop two different things: RATE at the edge, COUNTING in
#    the app.
#
# Careful: the plugin is maintained by Caddy's own author (mholt), but is still 0.x,
#    so the version is PINNED. Unpinned, one day the build would pull in a new version
#    by itself, and if it broke the cause would be hard to find.
FROM caddy:2-builder-alpine AS caddy-build
RUN xcaddy build \
      --with github.com/mholt/caddy-ratelimit@v0.1.0

# ── runtime ─────────────────────────────────────────────────────────────────
# Caddy was chosen over nginx: the config is small, the SPA fallback and gzip come by
#    default, and TLS is one line when needed (deploy/README.md › "TLS").
FROM caddy:2-alpine AS runtime

# Careful: the default binary is replaced, otherwise the `rate_limit` directive would
#    stay unrecognized and Caddy would NOT START at all ("unrecognized directive").
COPY --from=caddy-build /usr/bin/caddy /usr/bin/caddy

ENV TZ=UTC
RUN apk add --no-cache tzdata

# The PWA files go along with this one line too, nothing extra is needed:
#   - `public/` (manifest, favicon, icons): Vite copies it as-is into `dist/`
#   - `dist/sw.js`: built by the `oxeio-service-worker` plugin in `vite.config.ts`
# Careful: never add `public` to `.dockerignore`. The build would succeed and the app
#    would run, only the icons would vanish and the PWA could not be INSTALLED at all
#    (without a manifest the browser does not offer "Add to Home screen"). A silent
#    failure.
COPY --from=build /app/dist /srv
COPY Caddyfile /etc/caddy/Caddyfile

EXPOSE 8080
