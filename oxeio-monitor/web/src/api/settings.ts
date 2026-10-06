import { api } from './client';

/** Dashboard-editable settings: region, storage and backup, offsite copy, Telegram, agent update key. */

/**
 * এই কর্মীর জামানত **কোন মাস থেকে** কাটা শুরু (`YYYY-MM`)।
 *
 * ⚠️ `null` মানে "নিয়মের সাধারণ শুরুর মাসে ফেরত যাও" — বৈধ ও অর্থবহ।
 *
 * ⚠️⚠️ মাস এগিয়ে দিলে তার আগের কিস্তি **মুছে যায়**, আর কতগুলো গেল সেটা
 * রেসপন্সে আসে — পর্দা যেন নীরবে সারি মুছে না ফেলে।
 */
/**
 * ⚠️⚠️ **`tokenHint` — পুরো টোকেন কখনো আসে না।** সার্ভার শেষ চার অক্ষর
 * ছাড়া কিছু পাঠায় না, কারণ ব্রাউজারে গেলে সেটা DevTools, প্রক্সি লগ বা
 * স্ক্রিন শেয়ারে দেখা যেত।
 */
export interface TelegramSettingsView {
  configured: boolean;
  tokenHint: string | null;
  chatId: string;
  /** ⚠️ কোনটা খাটছে — ডাটাবেস না `.env`। না জানালে মালিক ভাবতেন সেভ হয়নি */
  source: 'database' | 'env' | 'none';
}
export function getTelegramSettings(
  signal?: AbortSignal,
): Promise<TelegramSettingsView> {
  return api<TelegramSettingsView>('/settings/telegram', { signal });
}
/**
 * ⚠️ খালি স্ট্রিং পাঠানো **বৈধ** — মানে "মুছে দাও, `.env`-এ ফেরত যাও"।
 */
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
 * ⭐ পরীক্ষামূলক বার্তা — নইলে মালিক সেভ করে **শুক্রবার পর্যন্ত** অপেক্ষা
 * করতেন, আর কিছু না এলে বুঝতেন ভুল ছিল, কিন্তু কী ভুল তা জানতেন না।
 */
export function testTelegram(): Promise<{ outcome: string }> {
  return api<{ outcome: string }>('/settings/telegram/test', { method: 'PATCH' });
}
// ── R5 · অফসাইট ব্যাকআপ (Backblaze B2) ──────────────────────────────────────

export interface OffsiteSettingsView {
  configured: boolean;
  /** `…9f2a` — application key বসানো না থাকলে `null` */
  keyHint: string | null;
  /** ⭐ গোপন নয় — পুরোটাই আসে, যাতে "আগেরটাই থাক" কাজ করে */
  keyId: string;
  bucket: string;
  /** ⚠️ কোনটা খাটছে — ডাটাবেস না সার্ভারের ফাইল */
  source: 'database' | 'env' | 'none';
}
export interface B2Verdict {
  ok: boolean;
  message: string;
  /** key-টা যে bucket-এ বাঁধা (সীমাবদ্ধ না হলে `null`) */
  boundTo: string | null;
}
export function getOffsiteSettings(
  signal?: AbortSignal,
): Promise<OffsiteSettingsView> {
  return api<OffsiteSettingsView>('/settings/offsite', { signal });
}
/**
 * ⚠️⚠️ `appKey` খালি পাঠানো মানে **"আগেরটাই থাক"** — টেলিগ্রামের চেয়ে
 * আলাদা, আর সেটা ইচ্ছাকৃত: Backblaze application key **একবারই দেখায়**,
 * তাই bucket-এর নাম শুধরাতে গিয়ে সেটা মুছে গেলে নতুন key বানাতে হতো।
 * ⭐ পুরোপুরি মুছতে হলে তিনটে ঘরই খালি রেখে সেভ।
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
 * ⭐⭐ কী-জোড়া সত্যিই কাজ করে কি না — **এখনই**। সার্ভার সরাসরি
 * Backblaze-কে জিজ্ঞেস করে, তাই ভুল key সাথে সাথেই ধরা পড়ে।
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
