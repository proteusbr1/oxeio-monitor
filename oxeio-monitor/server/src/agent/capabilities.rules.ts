/**
 * The agent's capability report (heartbeat `capabilities`) — pure rules, no I/O.
 *
 * Each agent says how each of its parts is doing: `ok`, `degraded`, `failed`
 * or `disabled_by_policy`. Before this, a part that stopped on its own (the
 * browser-domain reader gives up after 20 failures; the screen fingerprint
 * stops on a PC where capture is broken) left the dashboard looking normal.
 *
 * ⚠️ The report is taken in whatever shape it arrives and cleaned here,
 *    never refused: a heartbeat answered with 400 also loses its commands,
 *    revoke among them. Unknown parts and unknown states are dropped.
 */

export const CAPABILITY_NAMES = [
  'idleProbe',
  'appTracking',
  'browserDomain',
  'screenCapture',
  'screenActivity',
  'sync',
] as const;

export type CapabilityName = (typeof CAPABILITY_NAMES)[number];

export const CAPABILITY_STATES = [
  'ok',
  'degraded',
  'failed',
  'disabled_by_policy',
] as const;

export type CapabilityState = (typeof CAPABILITY_STATES)[number];

export type Capabilities = Partial<Record<CapabilityName, CapabilityState>>;

/** What the dashboard and the alert call each part */
export const CAPABILITY_LABEL: Record<CapabilityName, string> = {
  idleProbe: 'Idle detection',
  appTracking: 'App tracking',
  browserDomain: 'Website domains',
  screenCapture: 'Screenshots',
  screenActivity: 'Jiggler check',
  sync: 'Upload',
};

const isState = (v: unknown): v is CapabilityState =>
  typeof v === 'string' && (CAPABILITY_STATES as readonly string[]).includes(v);

/**
 * The report as sent, cleaned: only known parts with known states, in a
 * fixed key order (so two equal reports compare equal as JSON).
 * `null` when nothing usable came — an agent older than the field.
 */
export function sanitizeCapabilities(raw: unknown): Capabilities | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
    return null;

  const out: Capabilities = {};
  for (const name of CAPABILITY_NAMES) {
    const value = (raw as Record<string, unknown>)[name];
    if (isState(value)) out[name] = value;
  }
  return Object.keys(out).length === 0 ? null : out;
}

/** Parts that need attention: `degraded` or `failed`, in the fixed order */
export function brokenCapabilities(c: Capabilities | null): CapabilityName[] {
  if (!c) return [];
  return CAPABILITY_NAMES.filter(
    (n) => c[n] === 'degraded' || c[n] === 'failed',
  );
}

/** Same parts in the same states — then nothing is written */
export function sameCapabilities(
  a: Capabilities | null,
  b: Capabilities | null,
): boolean {
  if (a === null || b === null) return a === b;
  return CAPABILITY_NAMES.every((n) => a[n] === b[n]);
}

/** One line for the alert: `Website domains degraded · Screenshots failed` */
export function describeBroken(c: Capabilities): string {
  return brokenCapabilities(c)
    .map((n) => `${CAPABILITY_LABEL[n]} ${c[n]}`)
    .join(' · ');
}
