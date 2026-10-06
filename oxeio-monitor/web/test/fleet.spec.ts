import { describe, expect, it } from 'vitest';

import type { AgentVersionView, DeviceView } from '../src/api/agent';
import {
  capabilityIssues,
  compareVersion,
  fleetGroups,
  fleetTally,
  isQuiet,
  lagOf,
  newestOffered,
  QUIET_HOURS,
} from '../src/pages/settings/fleet';

/**
 * **Which PC is on which build.** The owner's direct question.
 *
 * The two most important tests here: **0.4.10 versus 0.4.9** (reversed in
 * string comparison), and **counting only active devices** (otherwise the same
 * screen would show two different numbers).
 */

const NOW = new Date('2026-08-18T14:40:00.000Z');

function device(over: Partial<DeviceView> = {}): DeviceView {
  return {
    id: 1,
    hostname: 'PC',
    windowsUsername: 'user',
    machineGuid: 'guid',
    osVersion: null,
    agentVersion: '0.4.9',
    monitors: 1,
    status: 'active',
    lastSeenAt: NOW.toISOString(),
    lastDriftSec: 0,
    maxDriftSec: 0,
    enrolledAt: NOW.toISOString(),
    employee: { id: 1, empCode: 'OX-01', fullName: 'One' },
    ...over,
  };
}

function version(over: Partial<AgentVersionView> = {}): AgentVersionView {
  return {
    version: '0.4.9',
    sha256: 'x',
    sizeBytes: 1,
    rolloutStage: 'partial',
    isMandatory: false,
    releaseNotes: null,
    releasedAt: NOW.toISOString(),
    fileMissing: false,
    devicesOn: 0,
    pilotDeviceId: null,
    pilotLabel: null,
    ...over,
  };
}

// ════════════════════════════════════════════════════════════════════════════

describe('compareVersion', () => {
  /**
   * **The most important test in the whole file.** In string comparison
   * `'0.4.10' < '0.4.9'` is true alphabetically, and the mistake is silent: the
   * screen would show the newest build as "behind" and nobody would know why.
   */
  it('0.4.10 is newer than 0.4.9', () => {
    expect(compareVersion('0.4.10', '0.4.9')).toBe(1);
    expect(compareVersion('0.4.9', '0.4.10')).toBe(-1);
  });

  it('zero when equal', () => {
    expect(compareVersion('1.2.3', '1.2.3')).toBe(0);
  });

  /** Careful: missing parts are zero: the server's `isNewer()` does exactly this */
  it('unequal length: missing parts count as zero', () => {
    expect(compareVersion('1.2', '1.2.0')).toBe(0);
    expect(compareVersion('1.2.1', '1.2')).toBe(1);
  });

  /** Careful: even with garbage input NaN must not spread */
  it('a non-numeric part is zero', () => {
    expect(compareVersion('0.4.9-beta', '0.4.9')).toBe(0);
  });
});

describe('newestOffered — what the server hands out', () => {
  /**
   * By order, not by version number: `UpdateService.offerFor` takes the first
   * non-halted row following `releasedAt desc`. Careful: picking by number here
   * would create two different "newest": the screen would call one the target
   * while the server handed out another.
   */
  it('the first in the list, skipping halted', () => {
    const list = [
      version({ version: '0.5.0', rolloutStage: 'halted' }),
      version({ version: '0.4.9', rolloutStage: 'partial' }),
      version({ version: '0.4.8', rolloutStage: 'halted' }),
    ];
    expect(newestOffered(list)).toBe('0.4.9');
  });

  it('no target at all when all are halted', () => {
    expect(newestOffered([version({ rolloutStage: 'halted' })])).toBeNull();
    expect(newestOffered([])).toBeNull();
  });
});

describe('lagOf — what to do', () => {
  it('already on the target', () => {
    expect(lagOf('0.4.9', '0.4.9')).toBe('newest');
  });

  /** Careful: a hand-installed newer build is not "behind" */
  it('not behind even when newer than the target', () => {
    expect(lagOf('0.5.0', '0.4.9')).toBe('newest');
  });

  /**
   * **These two being separate is the whole reason for this screen.** PCs on
   * 0.4.1+ will take the update just by waiting; those before 0.4.1 have no
   * tray menu at all, so someone has to go and install the MSI. On 18 August,
   * not knowing this difference, it was assumed that `partial` would give
   * everyone the update.
   */
  it('0.4.1+ will take it by itself, the earlier ones will not', () => {
    expect(lagOf('0.4.2', '0.4.9')).toBe('behind');
    expect(lagOf('0.4.1', '0.4.9')).toBe('behind');
    expect(lagOf('0.3.8', '0.4.9')).toBe('stranded');
    expect(lagOf('0.3.7', '0.4.9')).toBe('stranded');
  });

  it('unknown when the version is not known', () => {
    expect(lagOf(null, '0.4.9')).toBe('unknown');
  });

  /** Careful: with no target nobody is behind: the screen then hides the bar itself */
  it('with no target nobody is behind', () => {
    expect(lagOf('0.3.7', null)).toBe('newest');
  });
});

describe('isQuiet', () => {
  const at = (hoursAgo: number) =>
    new Date(NOW.getTime() - hoursAgo * 3_600_000).toISOString();

  /**
   * Careful: **being off all night is never "silent"**: closing at 6 pm and
   * opening at 9 am is 15 hours. If the threshold were lowered below that, the
   * whole fleet would look red every morning, and the mark would mean nothing.
   */
  it('15 hours (overnight) is not silent, 25 hours is', () => {
    expect(isQuiet(at(15), NOW)).toBe(false);
    expect(isQuiet(at(QUIET_HOURS + 1), NOW)).toBe(true);
  });

  /** Careful: never having responded does not mean "no problem" */
  it('silent if it never responded', () => {
    expect(isQuiet(null, NOW)).toBe(true);
  });

  it('no crash even with a broken date', () => {
    expect(isQuiet('not-a-date', NOW)).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════

describe('fleetGroups', () => {
  /**
   * Careful: **active only**: the "PCs on it" column of the neighbouring table
   * counts the same way (`agent-versions.service.ts`). Counting revoked PCs
   * would put **two different numbers on the same screen**, with no way to
   * tell which is true.
   */
  it('a revoked device is not counted', () => {
    const groups = fleetGroups(
      [
        device({ id: 1, agentVersion: '0.4.9' }),
        device({ id: 2, agentVersion: '0.4.9', status: 'revoked' }),
      ],
      '0.4.9',
      NOW,
    );

    expect(groups).toHaveLength(1);
    expect(groups[0].rows).toHaveLength(1);
    expect(groups[0].rows[0].deviceId).toBe(1);
  });

  it('groups from newest to oldest', () => {
    const groups = fleetGroups(
      [
        device({ id: 1, agentVersion: '0.3.7' }),
        device({ id: 2, agentVersion: '0.4.10' }),
        device({ id: 3, agentVersion: '0.4.9' }),
      ],
      '0.4.10',
      NOW,
    );

    expect(groups.map((g) => g.version)).toEqual(['0.4.10', '0.4.9', '0.3.7']);
    expect(groups.map((g) => g.lag)).toEqual(['newest', 'behind', 'stranded']);
  });

  /** Careful: an unknown version is not a group but a gap, so it goes last */
  it('devices that gave no version go last', () => {
    const groups = fleetGroups(
      [
        device({ id: 1, agentVersion: null }),
        device({ id: 2, agentVersion: '0.3.7' }),
      ],
      '0.4.9',
      NOW,
    );

    expect(groups.map((g) => g.version)).toEqual(['0.3.7', null]);
  });

  /** Careful: inside a group the order is by empCode, not by last response or hours */
  it('inside a group, in empCode order', () => {
    const groups = fleetGroups(
      [
        device({
          id: 1,
          employee: { id: 1, empCode: 'OX-09', fullName: 'Nine' },
        }),
        device({
          id: 2,
          employee: { id: 2, empCode: 'OX-04', fullName: 'Four' },
        }),
      ],
      '0.4.9',
      NOW,
    );

    expect(groups[0].rows.map((r) => r.employee?.empCode)).toEqual([
      'OX-04',
      'OX-09',
    ]);
  });

  /** Careful: devices not linked to an employee go last, but are **not dropped** */
  it('devices not linked to anyone stay at the end, not hidden', () => {
    const groups = fleetGroups(
      [
        device({ id: 1, employee: null, hostname: 'SPARE' }),
        device({
          id: 2,
          employee: { id: 2, empCode: 'OX-04', fullName: 'Four' },
        }),
      ],
      '0.4.9',
      NOW,
    );

    expect(
      groups[0].rows.map((r) => r.employee?.empCode ?? r.hostname),
    ).toEqual(['OX-04', 'SPARE']);
  });
});

describe('fleetTally', () => {
  /**
   * `behind` and `stranded` are counted separately because **the action
   * differs**: for one, waiting is enough; for the other someone must go and install.
   */
  it('counts in four parts, and the sum matches', () => {
    const groups = fleetGroups(
      [
        device({ id: 1, agentVersion: '0.4.9' }),
        device({ id: 2, agentVersion: '0.4.9' }),
        device({ id: 3, agentVersion: '0.4.2' }),
        device({ id: 4, agentVersion: '0.3.7' }),
        device({ id: 5, agentVersion: null }),
      ],
      '0.4.9',
      NOW,
    );

    expect(fleetTally(groups)).toEqual({
      newest: 2,
      behind: 1,
      stranded: 1,
      unknown: 1,
      total: 5,
    });
  });

  it('all zero when there is nothing', () => {
    expect(fleetTally([]).total).toBe(0);
  });
});

describe('capabilityIssues — what the agent says is not working', () => {
  it('an older agent without a report shows nothing', () => {
    expect(capabilityIssues(undefined)).toEqual([]);
    expect(capabilityIssues(null)).toEqual([]);
  });

  it('failed first and red, degraded after and amber, each with a hint', () => {
    const issues = capabilityIssues({
      browserDomain: 'degraded',
      screenActivity: 'failed',
      sync: 'ok',
    });
    expect(issues.map((i) => [i.text, i.tone])).toEqual([
      ['Jiggler check: not working', 'attention'],
      ['Website domains: unreliable', 'pending'],
    ]);
    expect(issues.every((i) => i.hint.length > 0)).toBe(true);
  });

  it('off by policy is a choice, not a fault', () => {
    expect(capabilityIssues({ screenCapture: 'disabled_by_policy' })).toEqual(
      [],
    );
  });

  it('a part this dashboard does not know is skipped', () => {
    expect(capabilityIssues({ somethingNew: 'failed' })).toEqual([]);
  });

  it('fleetGroups carries the issues on the row', () => {
    const [group] = fleetGroups(
      [device({ capabilities: { browserDomain: 'degraded' } })],
      '0.4.9',
      NOW,
    );
    expect(group.rows[0].issues.map((i) => i.text)).toEqual([
      'Website domains: unreliable',
    ]);
  });
});
