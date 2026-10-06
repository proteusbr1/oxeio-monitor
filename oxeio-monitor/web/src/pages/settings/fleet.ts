import type { AgentVersionView, DeviceView } from '../../api/agent';
import { translate } from '../../i18n';

/**
 * **Fleet versions: who stands where.**
 *
 * Careful — why this was needed: the owner asked "which agent version is on which
 * staff member's PC", and the answer was **nowhere on screen**. The route
 * `GET /api/v1/devices` returns everything and the web even had a `DeviceView`
 * type, but nobody ever called that route: another case of a contract written
 * with no caller.
 *
 * Careful: **not a new "Devices" screen** (the owner asked for that one to be
 * removed). This list sits inside **Agent updates**, whose own description reads
 * *"Which build each PC is offered"*.
 *
 * Important: the decisions live here, pure and testable, above all the version
 * comparison, which as a string comparison would make **0.4.10 < 0.4.9**.
 */

/**
 * **Agents older than 0.4.1 cannot update themselves.**
 *
 * Careful: the tray's "Install update" menu arrived in **0.4.1** (see the Build Log).
 * The `UpdateStager` in 0.3.7 does download the MSI but has no way to run
 * `msiexec`. So setting the rollout to `all` does nothing on those PCs: the file
 * downloads and sits there, and nobody knows. Important: so they are shown
 * separately: for them **a manual install is the only way**.
 */
export const TRAY_UPDATE_MIN = '0.4.1';

/**
 * How long a device may stay silent before its row is flagged.
 *
 * Careful: this is **not a rival** of the `agent_down` alert, which fires at 10
 * minutes and owns the question "is it down now". The question here is different:
 * *"is this PC's version even fresh news?"* A running agent responds every 5
 * minutes, so **a whole day** of silence means the machine is off or broken. 24
 * hours was chosen so that **being off overnight never lands here** (6pm to 9am =
 * 15 hours).
 */
export const QUIET_HOURS = 24;

/**
 * Important: an exact copy of the server's `isNewer()` (`server/src/agent/rollout.ts`).
 *
 * Careful: **string comparison is wrong here**, and silently so: `'0.4.10' < '0.4.9'`
 * is true alphabetically. It would do no harm today (still 0.4.9), but at the next
 * release the whole screen would say the opposite, showing the newest build as
 * "behind".
 *
 * Careful: if the two differ, the screen would call "up to date" a PC the server
 * would offer an update to; so the rule is kept identical, by copying.
 */
export function compareVersion(a: string, b: string): number {
  const x = a.split('.').map((n) => parseInt(n, 10) || 0);
  const y = b.split('.').map((n) => parseInt(n, 10) || 0);

  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const p = x[i] ?? 0;
    const q = y[i] ?? 0;
    if (p !== q) return p < q ? -1 : 1;
  }

  return 0;
}

/**
 * **Which build is "newest": exactly the way the server picks.**
 *
 * Careful: `UpdateService.offerFor` picks **by release time** (`releasedAt desc`),
 * not by version number, and skips `halted`. Picking by version number here would
 * create two different "newest" builds: the screen would call one the target and
 * the server would hand out another. So it takes the first non-halted row in the
 * order the list arrives in (the API is also `releasedAt desc`).
 *
 * Careful: if every version is halted it is `null`; then nobody is "behind",
 * because there is nowhere to advance to.
 */
export function newestOffered(
  versions: readonly AgentVersionView[],
): string | null {
  return versions.find((v) => v.rolloutStage !== 'halted')?.version ?? null;
}

/**
 * Where one PC stands relative to the target.
 *
 * - `newest`: on the target
 * - `behind`: behind, but **can update itself**
 * - `stranded`: so old its tray has no update menu; must be installed by hand
 * - `unknown`: the agent never reported its version
 */
export type FleetLag = 'newest' | 'behind' | 'stranded' | 'unknown';

/**
 * Careful: `newest === null` (every version halted, or nothing published) means
 * **there is no target**, so nobody is behind either. Careful, though: showing
 * "up to date" on screen then would be **false**; nobody is current, there is just
 * nothing to measure against. So in that state the screen hides both the marker
 * and the progress bar (`FleetCard`); here, just saying "not behind" is enough.
 */
export function lagOf(version: string | null, newest: string | null): FleetLag {
  if (version === null) return 'unknown';
  if (newest === null || compareVersion(version, newest) >= 0) return 'newest';

  /**
   * Careful: `>= 0`, not only `=== 0`. If someone installs a build **newer than the
   * target** by hand (which we do ourselves) they are not "behind"; treating
   * anything not equal as behind would show them in red.
   */
  return compareVersion(version, TRAY_UPDATE_MIN) >= 0 ? 'behind' : 'stranded';
}

/**
 * Careful: never responding still counts as "silent"; `null` here does not mean
 * "no problem". An agent that enrolled and never spoke is just as invisible.
 */
export function isQuiet(lastSeenAt: string | null, now: Date): boolean {
  if (lastSeenAt === null) return true;

  const seen = new Date(lastSeenAt).getTime();
  if (Number.isNaN(seen)) return true;

  return now.getTime() - seen > QUIET_HOURS * 3_600_000;
}

export interface FleetRow {
  deviceId: number;
  /** `null` if not linked to anyone; the row is still shown */
  employee: { empCode: string; fullName: string } | null;
  hostname: string;
  windowsUsername: string;
  lastSeenAt: string | null;
  quiet: boolean;
  driftSec: number;
  /** Parts of the agent that report trouble (capabilityIssues) */
  issues: CapabilityIssue[];
}

/** One part of the agent that reports trouble, ready to show */
export interface CapabilityIssue {
  /** e.g. `Website domains: not working` */
  text: string;
  /** red when it is down, amber when it only struggles */
  tone: 'attention' | 'pending';
  /** what it means and what to do — shown on hover */
  hint: string;
}

/** Same names as the server's `CAPABILITY_LABEL` — the alert uses those */
const CAPABILITY_LABEL: Record<string, string> = {
  idleProbe: 'Idle detection',
  appTracking: 'App tracking',
  browserDomain: 'Website domains',
  screenCapture: 'Screenshots',
  screenActivity: 'Jiggler check',
  sync: 'Upload',
};

/** What it means for the owner, and the first thing to try */
const CAPABILITY_HINT: Record<string, string> = {
  idleProbe:
    'Windows is not giving the agent the idle time, so active and idle cannot be told apart. Restart the PC; if it stays, reinstall the agent.',
  appTracking:
    'App usage is not being recorded on this PC. Check the agent log on that PC: %ProgramData%\\oXeio\\logs\\agent.log.',
  browserDomain:
    "The agent cannot read the browser address bar, so websites are missing from this PC's reports. Hours are not affected.",
  screenCapture:
    'Screenshots are not being taken on this PC. Hours are still counted; check the display driver and the agent log.',
  screenActivity:
    'The agent cannot sample the screen, so a mouse jiggler would go unnoticed on this PC. Hours are still counted.',
  sync: "Data is waiting on the PC and not reaching the server — nothing is lost, it uploads when the connection is back. Check this PC's network.",
};

/**
 * What the agent says is not working, one entry per part.
 *
 * Only `degraded` (amber, "unreliable") and `failed` (red, "not working") —
 * `disabled_by_policy` is a choice, not a fault, and showing it on every row
 * would bury the real ones. Unknown parts (a newer agent) are skipped rather
 * than shown under a raw name. Failed parts come first.
 */
export function capabilityIssues(
  capabilities: Record<string, string> | null | undefined,
): CapabilityIssue[] {
  if (!capabilities) return [];
  const names = Object.keys(CAPABILITY_LABEL);
  const pick = (state: string): CapabilityIssue[] =>
    names
      .filter((k) => capabilities[k] === state)
      .map((k) => ({
        text:
          state === 'failed'
            ? translate('{{part}}: not working', { part: translate(CAPABILITY_LABEL[k]) })
            : translate('{{part}}: unreliable', { part: translate(CAPABILITY_LABEL[k]) }),
        tone: state === 'failed' ? 'attention' : 'pending',
        hint: translate(CAPABILITY_HINT[k]),
      }));
  return [...pick('failed'), ...pick('degraded')];
}

export interface FleetGroup {
  /** `null` means the agent did not report its version */
  version: string | null;
  lag: FleetLag;
  rows: FleetRow[];
}

/**
 * **Groups by version, newest to oldest.**
 *
 * Sorted this way, "I said 50%, how far did it get?" can be answered **without
 * counting**, and that is the whole job of this tab.
 *
 * Careful: **only `active` devices**, because the neighbouring table's "PCs on it"
 * column counts the same way (`agent-versions.service.ts`, `where: { status:
 * 'active' }`). Counting revoked PCs would put **two different numbers on one
 * screen** with no way to tell which is true; this project has made exactly that
 * mistake once (G88).
 *
 * Careful: **inside** a group the order is by `empCode`, not by hours or last
 * response; this is a list for finding people, not a ranking.
 */
export function fleetGroups(
  devices: readonly DeviceView[],
  newest: string | null,
  now: Date,
): FleetGroup[] {
  const byVersion = new Map<string | null, FleetRow[]>();

  for (const d of devices) {
    if (d.status !== 'active') continue;

    const key = d.agentVersion ?? null;
    const rows = byVersion.get(key) ?? [];
    rows.push({
      deviceId: d.id,
      employee: d.employee
        ? { empCode: d.employee.empCode, fullName: d.employee.fullName }
        : null,
      hostname: d.hostname,
      windowsUsername: d.windowsUsername,
      lastSeenAt: d.lastSeenAt,
      quiet: isQuiet(d.lastSeenAt, now),
      driftSec: d.lastDriftSec,
      issues: capabilityIssues(d.capabilities),
    });
    byVersion.set(key, rows);
  }

  const groups: FleetGroup[] = [...byVersion.entries()].map(
    ([version, rows]) => ({
      version,
      lag: lagOf(version, newest),
      rows: rows.sort((a, b) => {
        // Careful: devices not linked to an employee go last; otherwise the empty cells
        //    would sit at the top of the list. Careful: the condition is written
        //    **explicitly**, not with a high-letter sentinel: `localeCompare` order
        //    changes by locale, so a sentinel could one day land in the middle.
        if ((a.employee === null) !== (b.employee === null)) {
          return a.employee === null ? 1 : -1;
        }
        return (a.employee?.empCode ?? a.hostname).localeCompare(
          b.employee?.empCode ?? b.hostname,
        );
      }),
    }),
  );

  return groups.sort((a, b) => {
    // Careful: unknown version goes last; it is not a "group", it is a gap
    if (a.version === null) return 1;
    if (b.version === null) return -1;
    return compareVersion(b.version, a.version);
  });
}

export interface FleetTally {
  newest: number;
  behind: number;
  stranded: number;
  unknown: number;
  total: number;
}

/**
 * Counts for the bar above.
 *
 * Important: `stranded` is counted separately because **the action differs**:
 * `behind` PCs will update themselves (just wait), while for `stranded` someone must
 * go and install the MSI. Calling both "old" would lose that difference.
 */
export function fleetTally(groups: readonly FleetGroup[]): FleetTally {
  const tally: FleetTally = {
    newest: 0,
    behind: 0,
    stranded: 0,
    unknown: 0,
    total: 0,
  };

  for (const g of groups) {
    tally[g.lag] += g.rows.length;
    tally.total += g.rows.length;
  }

  return tally;
}
