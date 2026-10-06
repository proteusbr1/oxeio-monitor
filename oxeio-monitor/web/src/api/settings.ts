import { api } from './client';

/** Dashboard-editable settings: region, storage and backup, offsite copy, Telegram, agent update key. */

/**
 * From which month this employee's deposit starts being deducted (`YYYY-MM`).
 *
 * Careful: `null` means "fall back to the rule's general start month"; that is
 * valid and meaningful.
 *
 * Careful: moving the month forward deletes the installments before it, and the
 * response says how many went. The screen must not delete rows silently.
 */
/**
 * Careful: `tokenHint`, the full token never comes back. The server sends nothing
 * except the last four characters, because once it reached the browser it could
 * leak through DevTools, proxy logs or screen sharing.
 */
export interface TelegramSettingsView {
  configured: boolean;
  tokenHint: string | null;
  chatId: string;
  /**
   * Careful: which one is in effect, the database or `.env`. Without this the owner
   * would think the save did not take.
   */
  source: 'database' | 'env' | 'none';
}
export function getTelegramSettings(
  signal?: AbortSignal,
): Promise<TelegramSettingsView> {
  return api<TelegramSettingsView>('/settings/telegram', { signal });
}
/** Careful: sending an empty string is valid; it means "delete it, fall back to `.env`". */
export function saveTelegramSettings(
  botToken: string,
  chatId: string,
): Promise<TelegramSettingsView> {
  return api<TelegramSettingsView>('/settings/telegram', {
    method: 'PATCH',
    body: { botToken, chatId },
  });
}
/**
 * A test message. Without it the owner would save and then wait for the next
 * scheduled message, and if nothing arrived would know something was wrong but not what.
 */
export function testTelegram(): Promise<{ outcome: string }> {
  return api<{ outcome: string }>('/settings/telegram/test', { method: 'PATCH' });
}
// ── R5 · Offsite backup (Backblaze B2) ──────────────────────────────────────

export interface OffsiteSettingsView {
  configured: boolean;
  /** `...9f2a`; `null` when no application key is set. */
  keyHint: string | null;
  /** Not secret; it comes back in full so that "keep the existing one" works. */
  keyId: string;
  bucket: string;
  /** Careful: which one is in effect, the database or the server's file. */
  source: 'database' | 'env' | 'none';
}
export interface B2Verdict {
  ok: boolean;
  message: string;
  /** The bucket the key is bound to (`null` if not restricted). */
  boundTo: string | null;
}
export function getOffsiteSettings(
  signal?: AbortSignal,
): Promise<OffsiteSettingsView> {
  return api<OffsiteSettingsView>('/settings/offsite', { signal });
}
/**
 * Careful: sending `appKey` empty means "keep the existing one". This differs from
 * Telegram, on purpose: Backblaze shows an application key only once, so deleting
 * it while fixing the bucket name would force a new key. To clear everything,
 * save with all three fields empty.
 */
export function saveOffsiteSettings(
  keyId: string,
  appKey: string,
  bucket: string,
): Promise<OffsiteSettingsView> {
  return api<OffsiteSettingsView>('/settings/offsite', {
    method: 'PATCH',
    body: { keyId, appKey, bucket },
  });
}
/**
 * Whether the key pair really works, right now. The server asks Backblaze
 * directly, so a wrong key is caught immediately.
 */
export function testOffsite(): Promise<B2Verdict> {
  return api<B2Verdict>('/settings/offsite/test', { method: 'POST' });
}
// ── Settings edited on screen instead of the server's .env ──────────────────

/** Where a value came from — saved on screen, the server's .env, or built in */
export type SettingSource = 'dashboard' | 'environment' | 'default';
export interface RegionSettings {
  timeZone: { value: string; source: SettingSource };
  /** the zone this server is running on — differs from `timeZone` until a restart */
  runningTimeZone: string;
  currency: { code: string; symbol: string; source: SettingSource };
  /** `null` = the dashboard's own formats */
  displayLocale: { value: string | null; source: SettingSource };
  restartNeeded: boolean;
}
export function getRegionSettings(signal?: AbortSignal): Promise<RegionSettings> {
  return api('/settings/region', { signal });
}
export function saveRegionSettings(body: {
  timeZone?: string;
  currency?: string;
  displayLocale?: string | null;
}): Promise<RegionSettings> {
  return api('/settings/region', { method: 'PATCH', body });
}
/** Stops the server so Docker / Coolify start it again (time zone, storage) */
export function restartServer(): Promise<{ ok: true }> {
  return api('/settings/restart', { method: 'POST' });
}
export interface StorageSettings {
  driver: 'local' | 's3';
  provider: 'b2' | 's3';
  bucket: string;
  endpoint: string;
  region: string;
  prefix: string;
  forcePathStyle: boolean;
  useBackupKey: boolean;
  keyIdHint: string | null;
  secretSet: boolean;
  source: SettingSource;
  running: { driver: 'local' | 's3'; location: string };
  restartNeeded: boolean;
}
export type StorageForm = {
  driver: 'local' | 's3';
  provider?: 'b2' | 's3';
  bucket?: string;
  endpoint?: string;
  region?: string;
  accessKeyId?: string;
  /** empty = keep the one already saved */
  secretAccessKey?: string;
  prefix?: string;
  forcePathStyle?: boolean;
  useBackupKey?: boolean;
};
export function getStorageSettings(signal?: AbortSignal): Promise<StorageSettings> {
  return api('/settings/storage', { signal });
}
export function testStorageSettings(body: StorageForm): Promise<{ ok: boolean; message: string }> {
  return api('/settings/storage/test', { method: 'POST', body });
}
export function saveStorageSettings(body: StorageForm): Promise<StorageSettings> {
  return api('/settings/storage', { method: 'PATCH', body });
}
export interface BackupModeSettings {
  /** `external` = the database is backed up by another tool (Databasus …) */
  mode: 'internal' | 'external';
  source: SettingSource;
}
export function getBackupMode(signal?: AbortSignal): Promise<BackupModeSettings> {
  return api('/settings/backup', { signal });
}
export function saveBackupMode(mode: 'internal' | 'external'): Promise<BackupModeSettings> {
  return api('/settings/backup', { method: 'PATCH', body: { mode } });
}
export interface UpdateKeySettings {
  /** one line of base64 — what build.ps1 -UpdatePublicKey takes */
  publicKey: string | null;
  source: SettingSource;
}
export function getUpdateKey(signal?: AbortSignal): Promise<UpdateKeySettings> {
  return api('/settings/update-key', { signal });
}
export function saveUpdateKey(publicKey: string | null): Promise<UpdateKeySettings> {
  return api('/settings/update-key', { method: 'PATCH', body: { publicKey } });
}

/** The company using this install — name and country */
export interface Organization {
  name: string;
  country: string | null;
}

export function getOrganization(signal?: AbortSignal): Promise<Organization> {
  return api('/settings/organization', { signal });
}

export function saveOrganization(body: { name: string; country: string }): Promise<Organization> {
  return api('/settings/organization', { method: 'PATCH', body });
}
