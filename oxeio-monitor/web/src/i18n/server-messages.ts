import i18n, { translate } from './index';
import serverKeys from './locales/pt-BR/server.json';

/**
 * The server answers in English, and its messages reach the screen as they
 * are (`ApiError.message`, test results such as "Connected. …"). This puts
 * them in the person's language at render time, without touching the server:
 *
 *  1. the whole message is a key in `locales/<lang>/server.json` → translated
 *  2. it matches one of the dynamic messages below (a value inside, like
 *     `No rule with id 42`) → that sentence translated, with the values kept
 *  3. otherwise it is returned unchanged — a new server message still reads
 *     correctly, in English
 *
 * Validation errors come as a list, which `api()` joins with ", "; each item
 * is translated on its own.
 *
 * Careful: a key here must be the server's text exactly, with every `${…}`
 * turned into a `{{name}}` placeholder; change one when the server's wording
 * changes, and its translations in `pt-BR/server.json` and `es/server.json`.
 * A placeholder named `count` makes the key plural (`_one`/`_other` entries).
 */
export const SERVER_MESSAGE_PATTERNS: readonly string[] = [
  'No staff member with id {{id}}',
  'No rule with id {{id}}',
  'A rule of this kind for "{{pattern}}" already exists (id {{id}}) — edit that one instead',
  'Another device is already registered as "{{device}}"',
  'A holiday has already been set for {{date}}',
  'Unknown leave type "{{type}}" — expected one of {{types}}',
  '{{days}} days is too long for one entry — 92 is the limit',
  '{{month}} is closed — reopen the month first',
  '{{months}} are closed — reopen the month first',
  'Expected YYYY-MM-DD, got "{{value}}"',
  '"{{value}}" is not a real date',
  'Expected YYYY-MM, got "{{value}}"',
  '{{month}} is still running — a month can only be closed once it is over',
  '{{month}} is in the future — there is nothing to close',
  '{{month}} was already closed on {{date}} by {{by}}',
  '{{month}} is not closed',
  'No instalment for {{month}} — the ledger only holds months the rule created',
  'The deposit of {{code}} is already settled ({{outcome}}).',
  'Version {{version}} is already published. Publish a new version number instead — agents compare versions, so re-publishing the same number would never reach anyone.',
  'No MSI at "{{path}}" (looked under the storage root). Copy the built file there first.',
  '{{version}} is not newer than the current {{latest}}, so no agent would ever be offered it.',
  '{{path}}.sig is not a signature — make it with: openssl dgst -sha256 -sign <key.pem> -out <msi>.sig <msi>',
  '{{code}} is inactive — activate the staff member first',
  '{{code}} is inactive — an enrolment code cannot be issued for an inactive staff member',
  'Sentry refused the key (HTTP {{status}}) — copy the DSN again.',
  'Sentry answered HTTP {{status}}.',
  'Could not reach Backblaze — {{reason}}',
  'Backblaze answered {{status}} — {{reason}}',
  'Backblaze answered {{status}}',
  'The key works, but it is restricted to the bucket “{{bound}}”, not “{{bucket}}”.',
  'Connected. The key is restricted to “{{bound}}”, which is what we want.',
  'Unknown subject — one of: {{subjects}}',
  'Connected — a test file was written to and deleted from {{bucket}}.',
  '{{field}} is not a valid date',
  'The email "{{email}}" is already registered to someone else',
  'The code "{{code}}" is already in use',
  'At most 500 tasks can be added at once — this paste has {{lines}} lines.',
  '{{month}} was closed on {{date}} by {{by}}. Payroll for that month is already fixed — reopen it first if this correction is genuinely needed.',
  'This Windows account is already registered to {{who}}. Sign in to your own Windows account on this PC, or ask the owner to revoke it first (Settings → Devices).',
  "The capture window start must be in 'HH:MM' format — got \"{{value}}\"",
  "The capture window end must be in 'HH:MM' format — got \"{{value}}\"",
  'The public holiday calendar answered HTTP {{status}}.',
  'Date must be in YYYY-MM-DD format — got "{{value}}"',
  'No such date on the calendar — "{{value}}"',
  'The range can be at most {{max}} days — {{days}} days were requested',
  'The language must be one of: {{languages}}',
  'DISPLAY_LOCALE="{{value}}" is not a locale tag (example: pt-BR, en-GB, de-DE)',
  "DISPLAY_LOCALE=\"{{value}}\" is not supported by this server's Intl data",
  'CURRENCY="{{value}}" is not an ISO 4217 code (example: USD, EUR, BRL)',
  'CURRENCY="{{value}}" has {{digits}} decimal places; amounts are stored in hundredths, so only currencies with 2 are supported',
  '"{{zone}}" is not a known IANA time zone (examples: America/Sao_Paulo, Europe/Lisbon, Asia/Kolkata)',
  'Request failed ({{status}})',
  "Couldn't build the file ({{status}})",
  'property {{property}} should not exist',
  'nested property {{property}} must be either object or array',
  '{{property}} must be a string',
  '{{property}} must be shorter than or equal to {{max}} characters',
  '{{property}} must be longer than or equal to {{min}} characters',
  '{{property}} must not be less than {{min}}',
  '{{property}} must not be greater than {{max}}',
  '{{property}} must be an integer number',
  '{{property}} must match {{pattern}} regular expression',
  '{{property}} must be a boolean value',
  '{{property}} must be one of the following values: {{values}}',
  '{{property}} must be a number conforming to the specified constraints',
  '{{property}} must be an array',
  '{{property}} must contain no more than {{max}} elements',
  '{{property}} must be an email',
  '{{property}} must be a Date instance',
  '{{property}} should not be empty',
  '{{property}} must be a positive number',
  '{{property}} must be a valid ISO 8601 date string',
  '{{property}} must be a UUID',
  'Too many failed attempts. Try again in {{count}} minutes.',
  '{{count}} staff are still on this policy — move them to another policy first',
  'You have already marked {{count}} tasks done today, so this one cannot be marked done — leave it in your list and finish it tomorrow.',
];

/**
 * The exact messages: `server.json`'s keys (the same in every language).
 * Only these count, not every key of the app — otherwise a value such as
 * "manager" in "role must be one of …: owner, manager" could be taken for a
 * message of its own.
 */
const KNOWN = new Set(Object.keys(serverKeys));

/** What each placeholder may match; anything else matches any text */
const CAPTURE: Record<string, string> = {
  property: '(\\S+)',
  field: '(\\S+)',
  count: '(\\d+)',
  status: '(\\d+)',
};

/** Placeholders whose value is itself a server message ("unknown error") */
const NESTED = new Set(['who', 'reason']);

interface Pattern {
  key: string;
  regex: RegExp;
  names: string[];
}

let compiled: Pattern[] | null = null;

function compile(key: string, text: string): Pattern {
  const names: string[] = [];
  const source = text
    .split(/(\{\{\w+\}\})/)
    .map((part) => {
      const name = /^\{\{(\w+)\}\}$/.exec(part)?.[1];
      if (!name) return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      names.push(name);
      return CAPTURE[name] ?? '(.+?)';
    })
    .join('');
  return { key, regex: new RegExp(`^${source}$`), names };
}

function patterns(): Pattern[] {
  if (compiled) return compiled;
  compiled = [];
  for (const key of SERVER_MESSAGE_PATTERNS) {
    compiled.push(compile(key, key));
    // a plural's singular reads differently ("in 1 minute.")
    const one = i18n.getResource('en', 'translation', `${key}_one`) as string | undefined;
    if (one && one !== key) compiled.push(compile(key, one));
  }
  return compiled;
}

/** One message: its translation, or `null` when it is not a known one */
function translateOne(message: string): string | null {
  if (KNOWN.has(message)) return translate(message);
  for (const { key, regex, names } of patterns()) {
    const match = regex.exec(message);
    if (!match) continue;
    const values: Record<string, unknown> = {};
    names.forEach((name, i) => {
      const value = match[i + 1];
      values[name] =
        name === 'count' ? Number(value) : NESTED.has(name) ? translateServerMessage(value) : value;
    });
    return translate(key, values);
  }
  return null;
}

interface Split {
  known: number;
  pieces: string[];
}

/**
 * A list joined with ", " — but a message can contain ", " itself
 * ("one of the following values: owner, manager"). So every way of grouping
 * the items is weighed: the one that recognises the most messages wins, then
 * the one with the fewest pieces. Unknown items stay as they are.
 */
function translateList(parts: string[]): string {
  const best: Split[] = [];
  best[parts.length] = { known: 0, pieces: [] };
  for (let i = parts.length - 1; i >= 0; i--) {
    const rest = best[i + 1];
    let choice: Split = { known: rest.known, pieces: [parts[i], ...rest.pieces] };
    for (let j = i + 1; j <= parts.length; j++) {
      const translated = translateOne(parts.slice(i, j).join(', '));
      if (translated === null) continue;
      const option: Split = { known: best[j].known + 1, pieces: [translated, ...best[j].pieces] };
      if (
        option.known > choice.known ||
        (option.known === choice.known && option.pieces.length < choice.pieces.length)
      ) {
        choice = option;
      }
    }
    best[i] = choice;
  }
  return best[0].pieces.join(', ');
}

/** A message from the server, in the language on screen (call it at render) */
export function translateServerMessage(message: string | readonly string[]): string {
  if (typeof message !== 'string') return message.map((m) => translateServerMessage(m)).join(', ');
  if (message.includes(', ')) return translateList(message.split(', '));
  return translateOne(message) ?? message;
}
