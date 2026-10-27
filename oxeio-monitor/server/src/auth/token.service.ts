import { randomBytes, randomUUID } from 'node:crypto';

import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { jwtVerify, SignJWT } from 'jose';

import {
  CSRF_COOKIE,
  SESSION_COOKIE,
  SESSION_TTL_MIN,
} from './auth.constants';
import type { SessionUser } from './types';

/** `revoked_sessions.session_id` is a UUID column; anything else is not ours */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Claims {
  email: string;
  role: string;
  employeeId: number | null;
  mustChangePw: boolean;
}

@Injectable()
export class TokenService implements OnModuleInit {
  private key!: Uint8Array;
  private secure = false;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    const secret = this.config.get<string>('JWT_SECRET');
    if (!secret || secret.length < 32) {
      // Fail fast: better the server does not start than starts with a weak secret
      throw new Error(
        'JWT_SECRET is not set or is shorter than 32 characters. Check .env.',
      );
    }
    this.key = new TextEncoder().encode(secret);
    this.secure = this.config.get<string>('NODE_ENV') === 'production';
  }

  async sign(user: Omit<SessionUser, 'issuedAt'>): Promise<string> {
    const claims: Claims = {
      email: user.email,
      role: user.role,
      employeeId: user.employeeId,
      mustChangePw: user.mustChangePw,
    };

    return new SignJWT({ ...claims })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(String(user.userId))
      // the same id on every refresh of one session; a new one on each login
      .setJti(user.sessionId ?? randomUUID())
      .setIssuedAt()
      .setExpirationTime(`${SESSION_TTL_MIN}m`)
      .sign(this.key);
  }

  async verify(token: string): Promise<SessionUser | null> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        algorithms: ['HS256'],
      });

      const userId = Number(payload.sub);
      if (!Number.isInteger(userId)) return null;

      return {
        userId,
        email: String(payload.email),
        role: payload.role as SessionUser['role'],
        employeeId:
          payload.employeeId === null ? null : Number(payload.employeeId),
        mustChangePw: payload.mustChangePw === true,
        issuedAt: Number(payload.iat ?? 0),
        ...(typeof payload.jti === 'string' && UUID.test(payload.jti)
          ? { sessionId: payload.jti }
          : {}),
      };
    } catch {
      // Expired, wrong signature or malformed token: all mean "not logged in"
      return null;
    }
  }

  /** Sets the session cookie and the CSRF cookie together */
  async issue(
    res: Response,
    user: Omit<SessionUser, 'issuedAt'>,
  ): Promise<void> {
    const token = await this.sign(user);
    const maxAge = SESSION_TTL_MIN * 60 * 1000;

    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: this.secure,
      path: '/',
      maxAge,
    });

    res.cookie(CSRF_COOKIE, randomBytes(24).toString('base64url'), {
      httpOnly: false, // the frontend must read it; this is the double-submit technique
      sameSite: 'strict',
      secure: this.secure,
      path: '/',
      maxAge,
    });
  }

  clear(res: Response): void {
    const opts = {
      sameSite: 'strict' as const,
      secure: this.secure,
      path: '/',
    };
    res.clearCookie(SESSION_COOKIE, { ...opts, httpOnly: true });
    res.clearCookie(CSRF_COOKIE, { ...opts, httpOnly: false });
  }
}
