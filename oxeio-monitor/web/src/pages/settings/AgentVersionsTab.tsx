import { useState } from 'react';
import { Trans } from 'react-i18next';

import { listAgentVersions, listDevices, publishAgentVersion, setAgentRollout, STAGE_LABEL, type AgentVersionView, type DeviceView, type RolloutStage } from '../../api/agent';
import { useApi } from '../../api/useApi';
import { Card } from '../../components/Card';
import { Button } from '../../components/Page';
import { Empty, ErrorBox, Loading } from '../../components/States';
import { Table } from '../../components/Table';
import { FleetCard } from './FleetCard';
import { UpdateKeyCard } from './UpdateKeyCard';
import { formatBytes, formatDateTime } from '../../lib/format';
import {
  Chip,
  FormGrid,
  FullWidth,
  Modal,
  Notice,
  SelectField,
  ServerError,
  TextAreaField,
  TextField,
  useMutation,
} from '../../components/ui';
import { useT } from '../../i18n';

/**
 * Rolling out new agent versions.
 *
 * Careful: the `agent_versions` table used to be **read only**. Staged rollout,
 * canary, sha256 checking, stopping with `halted`: everything was built, but there
 * was no path anywhere to insert a row into that table. So the only way to get a new
 * MSI onto 15 PCs was to go and install it by hand on each machine.
 *
 * Important: this page closes that gap, but is deliberately **small**: a list, one
 * "Publish", and a dropdown to change the stage. Nothing more (upload, build
 * trigger) is here; copying the MSI to the server is a separate job.
 */
export function AgentVersionsTab() {
  const t = useT();
  const { data, loading, error, reload } = useApi(
    (signal) => listAgentVersions(signal),
    [],
  );

  const [publishing, setPublishing] = useState(false);
  const rows = data ?? [];

  /**
   * The list for choosing a pilot; `FleetCard` makes this same call too.
   *
   * Careful: on failure it quietly stays an empty list: failing to fetch devices
   * must not break the versions page; changing the stage still works.
   */
  const fleet = useApi((signal) => listDevices(signal), []);
  const devices = fleet.data ?? [];

  return (
    <div className="space-y-4">
      {/*
        Careful: this warning is at the very top and always shown, because once a bad
        build is out there is **no** automatic way back (deliberate). Whoever picks
        "Everyone" should know in advance.
      */}
      <Notice tone="attention">
        <Trans
          i18nKey="There is no automatic rollback. If a build turns out to be bad, you can stop it here — but the PCs that already took it have to be fixed by hand. Start with <strong>a few PCs first</strong> and wait a day."
          components={{ strong: <strong /> }}
        />
      </Notice>

      <Card
        title={t('Agent Versions')}
        hint={t('Which build each PC is offered, and how widely')}
        padded={false}
        actions={<Button onClick={() => setPublishing(true)}>{t('Publish')}</Button>}
      >
        {loading && <Loading />}
        {error && <ErrorBox error={error} retry={reload} />}
        {!loading && !error && rows.length === 0 && (
          <Empty
            title={t('Nothing published yet')}
            hint={t('Agents keep running on whatever was installed by hand — they just never get offered an update.')}
          />
        )}
        {rows.length > 0 && <VersionTable
          rows={rows}
          devices={devices} onChanged={reload} />}
      </Card>

      {/*
        **Which PC is on which build.** The table above says how **many** PCs are
           on each version, but **which ones** was nowhere on screen. That was exactly
           the owner's question.

        Careful: **not** a new "Devices" tab (the owner asked for that to be removed).
           It sits here because the question comes up on this tab, and with the two
           numbers side by side you can see whether they agree.
      */}
      <FleetCard versions={rows} />

      {publishing && (
        <PublishDialog
          onClose={() => setPublishing(false)}
          onDone={() => {
            setPublishing(false);
            reload();
          }}
        />
      )}
      <UpdateKeyCard />
    </div>
  );
}

function VersionTable({
  rows,
  devices,
  onChanged,
}: {
  rows: AgentVersionView[];
  /** The list for choosing a pilot; when empty only "Nobody" is offered */
  devices: DeviceView[];
  onChanged: () => void;
}) {
  const t = useT();
  const { busy, error, run } = useMutation();

  return (
    <>
      <ServerError error={error} />
      <Table
        rows={rows}
        rowKey={(r) => r.version}
        columns={[
          {
            key: 'version',
            header: t('Version'),
            render: (r) => (
              <span className="num font-semibold">{r.version}</span>
            ),
          },
          {
            key: 'stage',
            header: t('Given to'),
            render: (r) => (
              <select
                value={r.rolloutStage}
                disabled={busy}
                onChange={(e) =>
                  run(async () => {
                    await setAgentRollout(
                      r.version,
                      e.target.value as RolloutStage,
                    );
                    onChanged();
                  })
                }
                className="rounded-md border border-line bg-surface px-2 py-1 text-[12.5px]"
              >
                {(
                  ['canary', 'partial', 'all', 'halted'] as const
                ).map((stage) => (
                  <option key={stage} value={stage}>
                    {t(STAGE_LABEL[stage])}
                  </option>
                ))}
              </select>
            ),
          },
          {
            /**
             * **A chosen PC.** The owner wanted OX-05 to get this update first.
             *
             * Careful: rollout runs **by machine** (hash buckets), not by person, so
             * the PC where the bug is found could not be the first to test the fix.
             * In the field OX-05's bucket was 86, while the canary was 7.
             *
             * Careful: at `Stopped` the pilot does not get it either: the emergency
             *    brake is for everyone. That is bound by the server's rules, not by
             *    the screen's good intentions.
             */
            key: 'pilot',
            header: t('First to'),
            render: (r) => (
              <select
                value={r.pilotDeviceId ?? ''}
                disabled={busy}
                title={t('This PC gets the build no matter what the rollout says')}
                onChange={(e) =>
                  run(async () => {
                    await setAgentRollout(
                      r.version,
                      r.rolloutStage,
                      e.target.value === '' ? null : Number(e.target.value),
                    );
                    onChanged();
                  })
                }
                className="rounded-md border border-line bg-surface px-2 py-1 text-[12.5px]"
              >
                {/* Careful: an empty value means "nobody"; so a blank looks intentional */}
                <option value="">{t('Nobody')}</option>
                {devices.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.employee?.fullName ?? d.hostname}
                  </option>
                ))}
              </select>
            ),
          },
          {
            key: 'devices',
            header: t('PCs on it'),
            align: 'right',
            render: (r) => <span className="num">{r.devicesOn}</span>,
          },
          {
            key: 'size',
            header: t('Size'),
            align: 'right',
            render: (r) =>
              /*
                Careful: the row exists but the file is not on disk: the agent would
                   get a 404 when downloading and the owner would never know. So this
                   is shown in red.
              */
              r.fileMissing ? (
                <Chip tone="attention">{t('MSI missing')}</Chip>
              ) : (
                <span className="num text-ink-3">
                  {formatBytes(r.sizeBytes)}
                  {/* PCs with the owner's update key only install signed MSIs */}
                  {r.signed && <span className="ml-1.5">· {t('signed')}</span>}
                </span>
              ),
          },
          {
            key: 'download',
            header: '',
            /*
              **Downloading the MSI for a manual install.**

              Careful: agents **older than** 0.4.1 have no "Install update" tray menu,
                 so staged rollout does not reach those PCs: the file downloads and
                 sits there, and nobody knows. They need one manual install, and there
                 was no way to get hold of the MSI for that.

              Careful: a plain `<a download>`, no JS. The file is 62 MB, and pulling
                 it into memory with fetch and making a blob would strain the browser
                 needlessly for a large file; the browser's own download is the right
                 tool here.
            */
            render: (r) =>
              r.fileMissing ? null : (
                <a
                  href={`/api/v1/agent-versions/${encodeURIComponent(r.version)}/download`}
                  download
                  className="rounded-md border border-line px-2 py-1 text-[12px] text-ink-2 transition hover:border-brand hover:text-ink"
                >
                  {t('Download MSI')}
                </a>
              ),
          },
          {
            key: 'released',
            header: t('Published'),
            render: (r) => (
              <span className="num text-ink-3">
                {formatDateTime(r.releasedAt)}
              </span>
            ),
          },
          {
            key: 'notes',
            header: '',
            render: (r) =>
              r.isMandatory ? <Chip tone="pending">{t('Mandatory')}</Chip> : null,
          },
        ]}
      />
    </>
  );
}

/**
 * Careful: **sha256 is not asked for**: the server reads the file and computes it
 * itself. One wrong character in a hand-entered hash would make 15 PCs download the
 * file, reject it on the hash mismatch, and download it again, forever.
 */
function PublishDialog({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useT();
  const { busy, error, run } = useMutation();

  const [version, setVersion] = useState('');
  const [msiPath, setMsiPath] = useState('updates/oXeioAgent.msi');
  const [notes, setNotes] = useState('');
  const [stage, setStage] = useState<RolloutStage>('canary');

  const ready = /^\d+\.\d+\.\d+/.test(version) && msiPath.trim().length > 0;

  return (
    <Modal
      title={t('Publish an agent version')}
      onClose={onClose}
      footer={
        <div className="flex justify-end gap-2">
          <Button onClick={onClose} disabled={busy}>
            {t('Cancel')}
          </Button>
          <Button
            tone="primary"
            disabled={busy || !ready}
            onClick={() =>
              run(async () => {
                await publishAgentVersion({
                  version: version.trim(),
                  msiPath: msiPath.trim(),
                  releaseNotes: notes.trim() || undefined,
                  rolloutStage: stage,
                });
                onDone();
              })
            }
          >
            {t('Publish')}
          </Button>
        </div>
      }
    >
      <ServerError error={error} />

      <Notice>
        <Trans
          i18nKey="Copy the built <code>oXeioAgent.msi</code> into the server's storage folder first — this only records where it is. The checksum is read from the file itself."
          components={{ code: <code /> }}
        />
      </Notice>

      <FormGrid>
        <TextField
          label={t('Version')}
          value={version}
          onChange={setVersion}
          placeholder="0.2.0"
          hint={t('Must be newer than the last one, or no agent would be offered it')}
          mono
          required
          autoFocus
        />

        <SelectField
          label={t('Give it to')}
          value={stage}
          onChange={(v) => setStage(v as RolloutStage)}
          options={[
            { value: 'canary', label: t(STAGE_LABEL.canary) },
            { value: 'partial', label: t(STAGE_LABEL.partial) },
            { value: 'all', label: t(STAGE_LABEL.all) },
          ]}
          hint={t('Start small — a bad build cannot be rolled back automatically')}
        />

        <FullWidth>
          <TextField
            label={t('Path on the server')}
            value={msiPath}
            onChange={setMsiPath}
            hint={t('Inside the storage folder, e.g. updates/oXeioAgent-0.2.0.msi')}
            mono
            required
          />
        </FullWidth>

        <FullWidth>
          <TextAreaField
            label={t('What changed')}
            value={notes}
            onChange={setNotes}
            hint={t('Optional — but a month later this is the only record of why')}
          />
        </FullWidth>
      </FormGrid>
    </Modal>
  );
}
