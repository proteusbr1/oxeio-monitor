import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  deriveSigningKey,
  signScreenshotToken,
  verifyScreenshotToken,
  type ScreenshotVariant,
  type SignInput,
  type VerifyResult,
} from './signed-url';

/**
 * Thin wrapper around the pure functions in signed-url.ts. Its only job is to
 * hold the secret. No calculation logic lives here, because once the secret
 * is involved the code could no longer be tested without the DB.
 */
@Injectable()
export class SignedUrlService implements OnModuleInit {
  private key!: Buffer;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    /**
     * `SCREENSHOT_URL_SECRET` can be set separately; otherwise `JWT_SECRET`.
     *
     * Careful: even with the same raw secret the keys differ.
     * `deriveSigningKey` mixes in a label, so a screenshot token can never
     * be used to create a session, or the reverse.
     */
    const raw =
      this.config.get<string>('SCREENSHOT_URL_SECRET') ??
      this.config.get<string>('JWT_SECRET');

    if (!raw || raw.length < 32) {
      // Fail fast, like TokenService: signing with a weak secret would let
      // anyone forge a link to any screenshot.
      throw new Error(
        'SCREENSHOT_URL_SECRET / JWT_SECRET is unset or shorter than 32 characters. Check .env.',
      );
    }

    this.key = deriveSigningKey(raw);
  }

  sign(input: SignInput): string {
    return signScreenshotToken(input, this.key);
  }

  verify(token: string): VerifyResult {
    return verifyScreenshotToken(token, this.key);
  }

  /**
   * The link sent in the response for each gallery photo.
   *
   * Careful: deliberately **relative**. The frontend proxies `/api` to the
   * server (vite.config.ts), and the SameSite=Strict cookie needs the same
   * origin. An absolute URL would break every link when the hostname changes.
   */
  urlFor(
    screenshotId: bigint,
    variant: ScreenshotVariant,
    viewerUserId: number,
  ): string {
    const token = this.sign({ screenshotId, variant, viewerUserId });
    return `/api/v1/screenshots/${screenshotId.toString()}/file?token=${encodeURIComponent(token)}`;
  }
}
