import { getHolidayAuto, runHolidayAuto, setHolidayAuto } from '../../api/calendar';
import { useApi } from '../../api/useApi';
import { useAuth } from '../../auth/AuthContext';
import { MiniButton, ServerError, useMutation } from '../../components/ui';
import { formatAgo } from '../../lib/format';
import { useT } from '../../i18n';

/**
 * "Keep public holidays up to date": every night the server imports this year
 * and next from the country's public calendar (BrasilAPI for Brazil,
 * Nager.Date elsewhere) — each year once, and never into a month already
 * counted. The owner switches it on; managers see the state and can run it.
 */
export function HolidayAutoUpdate({ onUpdated }: { onUpdated: () => void }) {
  const t = useT();
  const { user } = useAuth();
  const isOwner = user?.role === 'owner';
  const { data, reload } = useApi((signal) => getHolidayAuto(signal), []);
  const save = useMutation();

  if (!data) return null;

  const change = (task: () => Promise<unknown>) =>
    save.run(async () => {
      await task();
      reload();
      onUpdated();
    });

  return (
    <div className="rounded-md border border-line bg-surface px-3 py-2.5 text-[13px]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={data.enabled}
            disabled={!isOwner || save.busy}
            onChange={(e) => change(() => setHolidayAuto(e.target.checked))}
          />
          <span>
            {t('Keep public holidays up to date automatically')}
            {data.country && <span className="text-ink-3"> · {data.country}</span>}
          </span>
        </label>
        {data.enabled && (
          <MiniButton disabled={save.busy} onClick={() => change(runHolidayAuto)}>
            {save.busy ? t('Updating…') : t('Update now')}
          </MiniButton>
        )}
      </div>
      <p className="mt-1 text-[11.5px] leading-relaxed text-ink-3">
        {!data.country
          ? t('Choose the company’s country in Settings → Company & region first.')
          : data.enabled
            ? `${t('This year and next are imported from the country’s public calendar, each year once — a holiday you delete does not come back, and months already counted are never changed.')}${
                data.lastRunAt
                  ? ` ${t('Last run {{ago}}: {{result}}', { ago: formatAgo(data.lastRunAt), result: data.lastResult ?? '' })}`
                  : ''
              }`
            : t('Off — public holidays are only added when someone imports them.')}
      </p>
      <ServerError error={save.error} />
    </div>
  );
}
