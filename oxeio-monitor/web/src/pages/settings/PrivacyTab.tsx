import { useState } from 'react';
import { Trans } from 'react-i18next';

import {
  getPrivacy,
  RETENTION_MAX_DAYS,
  RETENTION_MIN_DAYS,
  savePrivacy,
} from '../../api/privacy';
import { useApi } from '../../api/useApi';
import { Card } from '../../components/Card';
import { ErrorBox, Loading } from '../../components/States';
import {
  CheckboxField,
  MiniButton,
  Notice,
  ServerError,
  TextField,
  useMutation,
} from '../../components/ui';
import { useT } from '../../i18n';

/**
 * Settings → Privacy: the choices *inside* the Screenshots module — who sees
 * the pictures and how long they are kept. Owner only, and only while the
 * module is on (the server answers 404 otherwise; `sections.ts` hides the tab).
 *
 * These are settings, not module switches: Settings → Modules turns the
 * pictures off for everyone; this page decides what happens while they are on.
 */
export function PrivacyTab() {
  const t = useT();
  const privacy = useApi(getPrivacy, []);
  const save = useMutation();

  const [staffSee, setStaffSee] = useState<boolean | null>(null);
  const [days, setDays] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const current = privacy.data;
  if (privacy.loading && !current) return <Loading />;
  if (privacy.error && !current)
    return <ErrorBox error={privacy.error} retry={privacy.reload} />;
  if (!current) return null;

  const { settings, staffLogins } = current;
  const see = staffSee ?? settings.staffSeeOwnScreenshots;
  const daysText = days ?? String(settings.screenshotRetentionDays);
  const daysNum = Number(daysText);
  const daysValid =
    daysText.trim() !== '' &&
    Number.isInteger(daysNum) &&
    daysNum >= RETENTION_MIN_DAYS &&
    daysNum <= RETENTION_MAX_DAYS;

  const changed =
    see !== settings.staffSeeOwnScreenshots ||
    (daysValid && daysNum !== settings.screenshotRetentionDays);
  // a shorter period deletes pictures that are kept today — said before saving
  const shortening = daysValid && daysNum < settings.screenshotRetentionDays;

  const edit = (apply: () => void) => {
    apply();
    setSaved(false);
    save.reset();
  };

  const submit = (): void =>
    save.run(async () => {
      await savePrivacy({
        staffSeeOwnScreenshots: see,
        screenshotRetentionDays: daysNum,
      });
      setStaffSee(null);
      setDays(null);
      setSaved(true);
      privacy.reload();
    });

  const logins = t('{{count}} staff logins', { count: staffLogins });

  return (
    <div className="space-y-3">
      <Notice>
        {t('Choices about the screenshots while they are taken. To stop taking them altogether, turn Screenshots off in Settings → Modules.')}
      </Notice>

      <Card title={t('Screenshots')} hint={t('Who sees them, and for how long')}>
        <div className="space-y-4 p-4">
          <CheckboxField
            label={t('Staff see their own screenshots')}
            checked={see}
            onChange={(next) => edit(() => setStaffSee(next))}
            hint={
              <Trans
                i18nKey="Staff and coordinator logins can open the pictures of their own screen, never anyone else’s — this affects <b>{{logins}}</b>. You and managers always see every picture. Either way, My data tells staff that pictures are taken and how long they are kept."
                values={{ logins }}
                components={{ b: <b /> }}
              />
            }
          />

          <TextField
            label={t('Keep screenshots for (days)')}
            type="number"
            value={daysText}
            onChange={(next) => edit(() => setDays(next))}
            mono
            min={RETENTION_MIN_DAYS}
            max={RETENTION_MAX_DAYS}
            step="1"
            hint={
              daysValid
                ? t('Older pictures are deleted every night. Staff see this number on My data. Between {{min}} and {{max}} days; 90 by default.', { min: RETENTION_MIN_DAYS, max: RETENTION_MAX_DAYS })
                : t('A whole number of days, between {{min}} and {{max}}.', { min: RETENTION_MIN_DAYS, max: RETENTION_MAX_DAYS })
            }
          />

          {shortening && (
            <Notice tone="attention">
              {t('The next nightly cleanup deletes every picture older than {{days}} days — the ones between {{days}} and {{current}} days old that are kept today cannot be brought back.', {
                days: daysNum,
                current: settings.screenshotRetentionDays,
              })}
            </Notice>
          )}

          <ServerError error={save.error} />
          <div className="flex items-center justify-end gap-3">
            {saved && !changed && (
              <span role="status" className="text-xs text-ink-2">
                {t('Saved')}
              </span>
            )}
            <MiniButton
              disabled={!changed || !daysValid || save.busy}
              onClick={submit}
            >
              {save.busy ? t('Saving…') : t('Save')}
            </MiniButton>
          </div>
        </div>
      </Card>
    </div>
  );
}
