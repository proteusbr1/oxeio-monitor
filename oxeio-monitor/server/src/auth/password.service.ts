import { randomBytes } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';

import { buildTempPassword, TEMP_PASSWORD_CHARS } from './temp-password';

/**
 * argon2id, I04.
 *
 * The `Algorithm` enum is deliberately not imported: @node-rs/argon2 ships it
 * as a `const enum` in the `.d.ts`, which cannot be used safely from outside
 * the module. argon2id is the library default, so there is no need to pass it explicitly.
 *
 * Parameters follow the OWASP recommendation: m = 19 MiB, t = 2, p = 1
 */
export const ARGON2_OPTIONS = {
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

@Injectable()
export class PasswordService {
  hash(plain: string): Promise<string> {
    return hash(plain, ARGON2_OPTIONS);
  }

  async verify(hashed: string, plain: string): Promise<boolean> {
    try {
      return await verify(hashed, plain, ARGON2_OPTIONS);
    } catch {
      // A broken hash or one in another format: safest to treat it as a failure
      return false;
    }
  }

  /**
   * When the owner resets someone's password (G33): shown only once, never
   * stored in plaintext anywhere.
   *
   * Careful: this used to be `randomBytes(12).toString('base64url')`, perfect
   * for secrecy and broken in use. With `l/I/1` and `O/0` side by side, staff
   * mistyped it again and again in the agent window, and 5 wrong attempts meant
   * a 15-minute lockout, so it looked as if **the reset itself was not working**
   * ([temp-password.ts](./temp-password.ts)).
   */
  generateTempPassword(): string {
    return buildTempPassword(randomBytes(TEMP_PASSWORD_CHARS));
  }
}
