import { INestApplication, ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';

/**
 * The same setup runs in both production (`main.ts`) and tests.
 *
 * It is kept in one place because if tests set up their own prefix/pipe/cookie,
 * tests could pass while production behaved differently.
 */
/**
 * Careful: `JSON.stringify` **throws** when it meets a BigInt: "Do not know
 * how to serialize a BigInt". And half our primary keys are BigInt
 * (`activity_segments`, `screenshots`, `app_usage`, `audit_log`).
 *
 * The result: an endpoint that returns an id by mistake gives a **500**, and
 * typecheck would never catch it, since everything is fine as far as types go.
 * Before this, every module had to do `String(id)` by hand, and if one person
 * forgot, that one route stayed silently broken.
 *
 * They are sent as strings, not numbers: beyond `Number.MAX_SAFE_INTEGER`
 * JavaScript would silently show wrong numbers.
 */
function enableBigIntJson(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (BigInt.prototype as any).toJSON = function (this: bigint): string {
    return this.toString();
  };
}

export function configureApp(
  app: INestApplication,
  opts: { corsOrigin?: string } = {},
): void {
  enableBigIntJson();

  app.setGlobalPrefix('api/v1');

  /**
   * **The real client IP behind the proxy.**
   *
   * Careful: this fixes two bugs:
   *
   * 1. **The login lockout had become a single bucket.** `login-throttle.service`
   *    counts per IP (`ipMaxFails`), but because Express did not trust the
   *    proxy, `req.ip` was the address of the **Caddy container**, the same
   *    for everyone. So 50 wrong logins from anywhere in the world would lock
   *    out **the whole office, owner included**: a one-line DoS.
   *
   * 2. **The audit log's IP was meaningless.** In answer to "who viewed my
   *    screenshots" every row showed the same internal address. Counted in
   *    the field: **all 494 rows** of 7 days had `172.18.0.4`.
   *
   * The default is **1**, because in the shipped topology there is always
   * exactly one hop in front (Caddy), and the API's port is bound to
   * `127.0.0.1`, so that is the only way in from outside.
   *
   * Careful: **do not raise the number.** The more hops `trust proxy` trusts,
   * the deeper a client can forge `X-Forwarded-For`, meaning it can choose its
   * own IP and dodge the lockout. Use 2 **when** Cloudflare sits in front, and
   * `TRUST_PROXY=0` when running bare without a proxy.
   *
   * Update: behind Cloudflare or any other proxy, keep 1 and set
   * `CADDY_TRUSTED_PROXIES` instead (web/Caddyfile). Caddy then decides the
   * client IP and hands this server a single address, so one hop is still
   * the whole chain.
   */
  // Careful: `set()` exists only on the Express adapter. Like `useBodyParser`
  // below, the type is narrowed here. Moving to Fastify would break this first,
  // which is right: better than silently falling back to the wrong IP.
  (app as NestExpressApplication).set('trust proxy', trustProxyHops());

  /**
   * **The JSON body cap is 8 MB**, at the owner's request.
   *
   * Careful: Express's default is **100 KB**, and it was not set here. So when
   * someone pasted a big list, the request got a 413 **before it even
   * reached validation**, with no understandable reason on screen.
   *
   * Careful: the cap is deliberately **larger than** the DTO's cap (5 MB), so
   * that when someone pastes too much they get our own understandable message
   * ("text must be shorter than...") and not Express's silent 413.
   */
  // Careful: `useBodyParser` exists only on the Express adapter, not on
  // `INestApplication`, so the type is narrowed here. Moving to Fastify would
  // break this line first, which is right: better than silently falling back to 100 KB.
  (app as NestExpressApplication).useBodyParser('json', { limit: '8mb' });

  app.use(helmet());
  app.use(cookieParser());

  // The token lives in an httpOnly cookie (ADR-016), so credentials are needed
  app.enableCors({
    origin: opts.corsOrigin ?? 'http://localhost:5173',
    credentials: true,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  );

  app.enableShutdownHooks();
}

/**
 * How many proxies are in front: `TRUST_PROXY`, default 1.
 *
 * Careful: an invalid or negative value does not silently become 0; it falls
 * back to the default. Otherwise a typo (`TRUST_PROXY=yes`) would quietly
 * bring the old bug back.
 */
function trustProxyHops(): number {
  const raw = process.env.TRUST_PROXY?.trim();
  if (raw === undefined || raw === '') return 1;

  const hops = Number(raw);
  if (!Number.isInteger(hops) || hops < 0) return 1;
  return hops;
}
