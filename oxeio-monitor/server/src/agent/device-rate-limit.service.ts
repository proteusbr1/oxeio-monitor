import { HttpException, HttpStatus, Injectable } from '@nestjs/common';

import {
  RATE_LIMIT_INGEST,
  RATE_LIMIT_SCREENSHOT,
} from './agent.constants';

type Bucket = 'ingest' | 'screenshot';

interface Window {
  count: number;
  resetAt: number;
}

/**
 * Simple per-device fixed-window rate limit (spec § 4.1).
 *
 * The goal is not security, since the token is already verified. The goal is
 * to stop a buggy or looping agent from flooding the server.
 * In-memory is therefore enough.
 */
@Injectable()
export class DeviceRateLimitService {
  private readonly windows = new Map<string, Window>();

  private limitFor(bucket: Bucket): number {
    return bucket === 'screenshot' ? RATE_LIMIT_SCREENSHOT : RATE_LIMIT_INGEST;
  }

  hit(deviceId: number, bucket: Bucket): void {
    const key = `${deviceId}:${bucket}`;
    const now = Date.now();
    const w = this.windows.get(key);

    if (!w || w.resetAt <= now) {
      this.windows.set(key, { count: 1, resetAt: now + 60_000 });
      this.prune(now);
      return;
    }

    w.count += 1;
    if (w.count > this.limitFor(bucket)) {
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: 'Sending too fast — please try again shortly',
          retryAfterSeconds: Math.ceil((w.resetAt - now) / 1000),
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private prune(now: number): void {
    if (this.windows.size < 200) return;
    for (const [k, w] of this.windows) {
      if (w.resetAt <= now) this.windows.delete(k);
    }
  }
}
