/**
 * The one place that builds query strings.
 *
 * Important: the server has a global `ValidationPipe` with
 * `whitelist + forbidNonWhitelisted`. Any parameter not in the DTO gets a 400
 * instead of being silently ignored. Two traps:
 *   - names are camelCase (`?employeeId=3`), not snake_case
 *   - a value of `undefined` must not be sent at all: `?date=undefined` fails
 *     the regex and gives a 400
 *
 * So the filter below protects every API function. Do not hand-write `?a=${x}`.
 */
export type QueryValue = string | number | boolean | null | undefined;

export function qs(params: Record<string, QueryValue>): string {
  const search = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    // Empty strings are dropped too: an empty input box would send `?search=`, and
    // for some DTOs that violates `@MinLength` and returns a 400.
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }

  const text = search.toString();
  return text ? `?${text}` : '';
}
