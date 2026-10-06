import { Trans } from 'react-i18next';

import type { AgentVersionView } from '../../api/agent';
import { listDevices } from '../../api/agent';
import { useApi } from '../../api/useApi';
import { Card } from '../../components/Card';
import { Empty, ErrorBox, Loading } from '../../components/States';
import { PersonCell, Table } from '../../components/Table';
import { formatAgo } from '../../lib/format';
import {
  fleetGroups,
  fleetTally,
  newestOffered,
  type FleetGroup,
  type FleetRow,
} from './fleet';
import { Chip } from '../../components/ui';
import { useT } from '../../i18n';

/**
 * **Which PC is on which build.**
 *
 * Careful: **this is not the "Devices" screen coming back**; the owner asked for
 * that to be removed (he said he did not want the Devices option because it made
 * the whole system more complex), and the reason still holds: the same question had
 * to be looked up on two screens.
 *
 * Important: so the list is **in this tab**, whose own description reads *"Which
 * build each PC is offered"*: the answer is where the question arises. And it is
 * deliberately **view only**: no revoke/restore buttons, because switching an agent
 * off and on happens in the Staff row ("Turn agent on"). Adding buttons would bring
 * back exactly that two-screen dilemma.
 */
export function FleetCard({ versions }: { versions: AgentVersionView[] }) {
  const t = useT();
  const { data, loading, error, reload } = useApi(
    (signal) => listDevices(signal),
    [],
  );

  const newest = newestOffered(versions);
  /**
   * Careful: `new Date()` is taken at render time: the "silent" check is on a
   * 24-hour scale, so a second or two of drift is meaningless here. Month-based
   * logic could not do this, but here there is no need to pull in a separate clock.
   */
  const groups = fleetGroups(data ?? [], newest, new Date());
  const tally = fleetTally(groups);

  return (
    <Card
      title={t('Where the Fleet Stands')}
      hint={t('Which PC is running which build right now')}
      padded={false}
    >
      {loading && !data && <Loading />}
      {error && <ErrorBox error={error} retry={reload} />}
      {!loading && !error && tally.total === 0 && (
        <Empty
          title={t('No active PCs')}
          hint={t('Nothing is enrolled yet, so there is nothing to update.')}
        />
      )}

      {tally.total > 0 && (
        <>
          {/*
            Careful: when nothing is published (or everything is halted) the progress
               bar is not shown: the text "13/13 on the newest build" would then be
               **false**; with no target, nobody is current either.
          */}
          {newest !== null && <RolloutBar tally={tally} newest={newest} />}
          <FleetTable groups={groups} />
        </>
      )}
    </Card>
  );
}

/**
 * **How far the rollout is, without counting.**
 *
 * Careful: three groups, not two: `behind` PCs **will update themselves** (waiting
 * is enough), but for `stranded` ones someone must go and install the MSI. Calling
 * both "old" would lose that difference in what to do, and it was not knowing that
 * difference that led to assuming on 18 August that `partial` would update everyone
 * (see the Build Log).
 */
function RolloutBar({
  tally,
  newest,
}: {
  tally: ReturnType<typeof fleetTally>;
  newest: string;
}) {
  const t = useT();
  const pct = (n: number) => `${(n / tally.total) * 100}%`;

  return (
    <div className="border-b border-line px-4 pt-3 pb-4">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-[13px] text-ink-2">
          <Trans
            i18nKey="<strong>{{newest}}</strong> of <num>{{count}}</num> PCs are on <ver>{{version}}</ver>"
            count={tally.total}
            values={{ newest: tally.newest, count: tally.total, version: newest }}
            components={{
              strong: <span className="num font-semibold text-ink" />,
              num: <span className="num" />,
              ver: <span className="num font-semibold" />,
            }}
          />
        </span>
      </div>

      {/* Careful: `flex` + percentage widths; a gradient on one `<div>` would blur the
          group boundaries, and here the boundary is the information */}
      <div className="flex h-2.5 overflow-hidden rounded-full bg-line">
        <div style={{ width: pct(tally.newest) }} className="bg-ok" />
        <div style={{ width: pct(tally.behind) }} className="bg-idle" />
        <div style={{ width: pct(tally.stranded) }} className="bg-brand" />
        <div style={{ width: pct(tally.unknown) }} className="bg-ink-3" />
      </div>

      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12.5px] text-ink-2">
        <Key tone="bg-ok" n={tally.newest} label={t('on the newest build')} />
        <Key tone="bg-idle" n={tally.behind} label={t('behind — they update themselves')} />
        <Key tone="bg-brand" n={tally.stranded} label={t('too old to update themselves')} />
        <Key tone="bg-ink-3" n={tally.unknown} label={t('never reported a version')} />
      </div>
    </div>
  );
}

/** Careful: not shown at zero; "0 old" takes time to read and no time to understand */
function Key({ tone, n, label }: { tone: string; n: number; label: string }) {
  if (n === 0) return null;

  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`inline-block h-2 w-2 rounded-[2px] ${tone}`} />
      <span className="num font-semibold text-ink">{n}</span>
      <span>{label}</span>
    </span>
  );
}

/** A table row, with which group it is in and whether it is the group's first */
interface Flat extends FleetRow {
  group: FleetGroup;
  first: boolean;
}

function FleetTable({ groups }: { groups: FleetGroup[] }) {
  const t = useT();
  const rows: Flat[] = groups.flatMap((group) =>
    group.rows.map((row, i) => ({ ...row, group, first: i === 0 })),
  );

  return (
    <Table
      rows={rows}
      rowKey={(r) => String(r.deviceId)}
      groupBefore={(r) => (r.first ? <VersionBand group={r.group} /> : null)}
      columns={[
        {
          key: 'staff',
          header: t('Staff'),
          render: (r) =>
            r.employee ? (
              <PersonCell
                fullName={r.employee.fullName}
                empCode={r.employee.empCode}
              />
            ) : (
              // Careful: devices not linked to an employee are shown too; hiding them
              //    would make the fleet count disagree with the neighbouring column
              <span className="text-ink-3">{t('Not linked to anyone')}</span>
            ),
        },
        {
          key: 'pc',
          header: t('PC'),
          render: (r) => <span className="num">{r.hostname}</span>,
        },
        {
          key: 'user',
          header: t('Windows user'),
          render: (r) => (
            <span className="num text-ink-3">{r.windowsUsername}</span>
          ),
        },
        {
          key: 'seen',
          header: t('Last seen'),
          align: 'right',
          render: (r) => (
            <span className={`num ${r.quiet ? 'text-brand-ink' : 'text-ink-3'}`}>
              {formatAgo(r.lastSeenAt)}
            </span>
          ),
        },
        {
          key: 'flag',
          header: '',
          /*
            Important: a flag on a row only when **this row itself** has something to
               say. How far behind the version is is written in the band above, so
               repeating the same thing on every row is noise, not information.
          */
          render: (r) =>
            r.quiet || r.issues.length > 0 ? (
              <span className="inline-flex flex-wrap justify-end gap-1">
                {r.quiet && <Chip tone="attention">{t('Quiet')}</Chip>}
                {/* the agent's own report — see capabilityIssues() */}
                {r.issues.map((issue) => (
                  <span key={issue.text} title={issue.hint}>
                    <Chip tone={issue.tone}>{issue.text}</Chip>
                  </span>
                ))}
              </span>
            ) : null,
        },
      ]}
    />
  );
}

/**
 * One line at the top of a group: the version, how many, and **what to do**.
 *
 * Careful: the action must be written: reading "0.3.7 - 5 PCs" does not reveal that
 * someone must go and install on those five by hand, which is the only way.
 */
function VersionBand({ group }: { group: FleetGroup }) {
  const t = useT();
  const n = group.rows.length;

  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
      <span className="num text-[14px] font-semibold text-ink">
        {group.version ?? t('Version unknown')}
      </span>
      <span className="text-[12.5px] text-ink-3">
        {t('{{count}} PCs', { count: n })}
      </span>

      {group.lag === 'newest' && (
        <span className="text-[12.5px] text-ok-ink">· {t('newest build')}</span>
      )}
      {group.lag === 'behind' && (
        <span className="text-[12.5px] text-idle-ink">
          · {t('behind — the tray offers the update by itself')}
        </span>
      )}
      {group.lag === 'stranded' && (
        <span className="text-[12.5px] text-brand-ink">
          · {t('too old to update itself — install the MSI by hand')}
        </span>
      )}
      {group.lag === 'unknown' && (
        <span className="text-[12.5px] text-ink-3">
          · {t('the agent never said which build it runs')}
        </span>
      )}
    </div>
  );
}
