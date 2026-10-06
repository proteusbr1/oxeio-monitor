import { api } from '../api/client';

/**
 * API calls for I06/I09.
 *
 * Careful: written here, not in `src/api/auth.ts`, because that file is outside
 * the scope of this work. `login` is rewritten here because 2FA needs two extra
 * fields and a new kind of response (`needsTotp`). `me`/`logout` remain unchanged
 * in `src/api/auth.ts`.
 */

export interface LoginResponse {
  /** When true, the session cookie was not set; ask for the code and send again. */
  needsTotp?: true;
  mustChangePassword?: boolean;
  usedRecoveryCode?: boolean;
  recoveryCodesLeft?: number | null;
}

export interface LoginCredentials {
  email: string;
  password: string;
  totp?: string;
  recoveryCode?: string;
}

export function login(creds: LoginCredentials): Promise<LoginResponse> {
  return api('/auth/login', {
    method: 'POST',
    body: creds,
    // A 401 for a wrong password/code must not trigger a global logout.
    silent401: true,
  });
}

export interface SessionPolicy {
  idleTimeoutSec: number;
  warnBeforeSec: number;
}

/**
 * Careful: the numbers are fetched from the server rather than hard-coded in the
 * frontend. Otherwise, if the server's TTL changed one day, the browser would
 * warn at 30 minutes while the session died at 15 (or the reverse), and nobody
 * would notice.
 */
export function sessionPolicy(): Promise<SessionPolicy> {
  return api('/auth/session-policy', { silent401: true });
}

export interface TwoFactorStatus {
  enabled: boolean;
  /** The QR was generated but not yet proven with a code. */
  pendingSetup: boolean;
  recoveryCodesLeft: number;
}

export interface TwoFactorSetup {
  secret: string;
  otpauthUri: string;
  /** `data:image/png;base64,…` */
  qrDataUrl: string;
}

export function twoFactorStatus(signal?: AbortSignal): Promise<TwoFactorStatus> {
  return api('/auth/2fa', { signal });
}

export function setupTwoFactor(): Promise<TwoFactorSetup> {
  return api('/auth/2fa/setup', { method: 'POST' });
}

export function enableTwoFactor(code: string): Promise<{ recoveryCodes: string[] }> {
  return api('/auth/2fa/enable', { method: 'POST', body: { code } });
}

export function disableTwoFactor(password: string): Promise<void> {
  return api('/auth/2fa/disable', { method: 'POST', body: { password } });
}

export function regenerateRecoveryCodes(
  password: string,
): Promise<{ recoveryCodes: string[] }> {
  return api('/auth/2fa/recovery-codes', { method: 'POST', body: { password } });
}
