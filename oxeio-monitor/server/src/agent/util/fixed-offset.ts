/**
 * Minutes east of UTC for a time zone without DST — no side effects.
 *
 * Kept apart from work-time.ts on purpose: that module reads WORK_TIMEZONE
 * the moment it is imported, and main.ts has to check the zone saved on
 * Settings → Region *before* that happens.
 */
/**
 * Minutes east of UTC for `timeZone` (for example Asia/Dhaka = 360, America/Sao_Paulo =
 * -180). Throws if the name is unknown or the zone observes DST in `year`.
 *
 * Compares 1 January with 1 July: any DST rule, northern or southern
 * hemisphere, puts those two dates on different offsets.
 */
export function fixedOffsetMinutes(
  timeZone: string,
  year = new Date().getUTCFullYear(),
): number {
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone,
      timeZoneName: 'longOffset',
    });
  } catch {
    throw new Error(
      `WORK_TIMEZONE="${timeZone}" is not a known IANA time zone ` +
        `(example: Asia/Dhaka, America/Sao_Paulo)`,
    );
  }

  const offsetAt = (month: number): number => {
    const name =
      format
        .formatToParts(new Date(Date.UTC(year, month, 1, 12)))
        .find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
    // "GMT+06:00" · "GMT-03:00" · "GMT" (UTC itself has no digits)
    const m = /^GMT(?:([+-])(\d{2}):(\d{2}))?$/.exec(name);
    if (!m) throw new Error(`Unexpected offset "${name}" for ${timeZone}`);
    if (!m[1]) return 0;
    const minutes = Number(m[2]) * 60 + Number(m[3]);
    return m[1] === '-' ? -minutes : minutes;
  };

  const january = offsetAt(0);
  if (offsetAt(6) !== january) {
    throw new Error(
      `WORK_TIMEZONE="${timeZone}" observes daylight saving time, which is ` +
        `not supported yet: every work date is computed with one fixed offset`,
    );
  }
  return january;
}
