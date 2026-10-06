import { api } from './client';

/** PCs (devices) and the agent builds offered to them. */

export type DeviceStatus = 'active' | 'revoked';
// ── ডিভাইস (owner-only) ─────────────────────────────────────────────────────

export interface DeviceView {
  id: number;
  hostname: string;
  windowsUsername: string;
  machineGuid: string;
  osVersion: string | null;
  agentVersion: string | null;
  monitors: number;
  status: DeviceStatus;
  /** ISO instant — কখনো সাড়া না দিলে `null` */
  lastSeenAt: string | null;
  /** ঘড়ির হেরফের, সেকেন্ডে — বড় হলে সময়ের হিসাব সন্দেহজনক */
  lastDriftSec: number;
  maxDriftSec: number;
  /**
   * The agent's own report on its parts, e.g. `{ browserDomain: 'degraded' }`.
   * `null`/missing until an agent that sends it checks in.
   */
  capabilities?: Record<string, string> | null;
  capabilitiesAt?: string | null;
  enrolledAt: string;
  /** কোনো কর্মীর সাথে যুক্ত না থাকলে `null` */
  employee: { id: number; empCode: string; fullName: string } | null;
}
/**
 * ⚠️⚠️ **এই রুটটা সার্ভারে বহুদিন ধরে ছিল, ওয়েব একবারও ডাকেনি।**
 *
 * উপরের `DeviceView` টাইপটাও লেখা হয়ে বসে ছিল — অর্থাৎ চুক্তির দুই পাশই
 * তৈরি, মাঝখানে কল নেই। ফল: *"কোন PC-তে কোন এজেন্ট চলছে"* প্রশ্নের উত্তর
 * পর্দার কোথাও ছিল না, যদিও ডেটাটা এক কল দূরে (১৮ আগস্ট, মালিকের প্রশ্ন)।
 *
 * ⚠️ owner-only (`@Roles(UserRole.owner)`), আর সার্ভার `{ rows, total }`
 * খামে পাঠায় — `total` এখানে লাগে না, সারিগুলোই ফেরত দেওয়া হয়।
 */
export function listDevices(signal?: AbortSignal): Promise<DeviceView[]> {
  return api<{ rows: DeviceView[]; total: number }>('/devices', {
    signal,
  }).then((r) => r.rows);
}
// ── H04 · এজেন্টের ভার্সন বিলি ──────────────────────────────────────────────

export type RolloutStage = 'canary' | 'partial' | 'all' | 'halted';
/**
 * ⚠️ লেখাগুলো owner-এর পর্দায় যায়, তাই কারিগরি নাম নয় — "canary" শব্দটা
 * কী বোঝায় সেটা ধরে নেওয়া যায় না।
 */
export const STAGE_LABEL: Record<RolloutStage, string> = {
  canary: 'A few PCs first',
  partial: 'About half',
  all: 'Everyone',
  halted: 'Stopped',
};
export interface AgentVersionView {
  version: string;
  sha256: string;
  sizeBytes: number | null;
  rolloutStage: RolloutStage;
  isMandatory: boolean;
  releaseNotes: string | null;
  releasedAt: string;
  /** ⚠️ সারি আছে কিন্তু MSI-টা ডিস্কে নেই — এজেন্ট নামাতে গিয়ে ৪০৪ পাবে */
  fileMissing: boolean;
  /** Published with the owner's signature (`<msi>.sig`); optional for older servers */
  signed?: boolean;
  devicesOn: number;
  /**
   * ⭐⭐ **বালতি নির্বিশেষে যে PC-টা আগে পায়** *(১ সেপ্টেম্বর ২০২৬)* —
   * `null` মানে কেউ নয়।
   */
  pilotDeviceId: number | null;
  /** ⭐ পর্দায় দেখানোর নাম — কর্মীর নাম, না থাকলে hostname */
  pilotLabel: string | null;
}
export function listAgentVersions(
  signal?: AbortSignal,
): Promise<AgentVersionView[]> {
  return api<AgentVersionView[]>('/agent-versions', { signal });
}
export function publishAgentVersion(body: {
  version: string;
  msiPath: string;
  releaseNotes?: string;
  rolloutStage?: RolloutStage;
  isMandatory?: boolean;
}): Promise<AgentVersionView> {
  // ⚠️ `body` কাঁচা অবজেক্ট — `api()` নিজেই `JSON.stringify` করে।
  //    এখানে আগেই stringify করলে দুবার এনকোড হয়ে সার্ভারে একটা
  //    **স্ট্রিং** পৌঁছাত, আর ব্রাউজারে আসত `"…" is not valid JSON`।
  return api<AgentVersionView>('/agent-versions', { method: 'POST', body });
}
/**
 * ⚠️⚠️ `pilotDeviceId` **না পাঠানো** আর **`null` পাঠানো** এক নয়: প্রথমটা
 * "যা ছিল তাই থাক", দ্বিতীয়টা "পাইলট তুলে দাও"। ⭐ পার্থক্যটা না রাখলে
 * শুধু ধাপ বদলাতে গেলেই বেছে নেওয়া PC-টা নীরবে মুছে যেত।
 */
export function setAgentRollout(
  version: string,
  rolloutStage: RolloutStage,
  pilotDeviceId?: number | null,
): Promise<AgentVersionView> {
  return api<AgentVersionView>(
    `/agent-versions/${encodeURIComponent(version)}/stage`,
    {
      method: 'POST',
      body:
        pilotDeviceId === undefined
          ? { rolloutStage }
          : { rolloutStage, pilotDeviceId },
    },
  );
}
