# Work hours, schedule compliance and the pay-period hours statement — design

Date: 2026-10-09 · Status: approved in conversation, awaiting written review

## 1. Why

The company has two kinds of staff:

- **Salaried with a fixed schedule** (e.g. Monday–Friday, 08:00–17:00, a
  mandatory 60-minute break). The owner needs to know whether the schedule
  is kept: arrival, leaving and the break.
- **Hourly staff** with free hours. Their hours are entered by hand, by a
  finance employee, into an outside payroll system (Agilize: "hours
  worked", integer hours plus minutes). The pay period closes on the 25th.

The finance employee must see those hours on screen and receive an email
with everything needed to post them. Posting stays manual; automating it is
out of scope.

## 2. Decisions taken

| Question | Decision |
|---|---|
| What counts as worked time | **Presence**: from the first to the last use of the computer in the day, minus pauses longer than a threshold. Chosen per work policy; the code default stays "active time" (today's behaviour). |
| Long-pause threshold | 15 minutes by default, set on the policy |
| Pay period | From the day after the cutoff to the cutoff day, inclusive (26th → 25th). Cutoff day configurable; generic default is "end of month" (calendar month). |
| When the statement goes out | The day after the cutoff, 07:00 in the company time zone (26th, 07:00). Configurable time. |
| Late corrections | Changes to days already sent flow into the next statement as a carry-over. |
| Break rule | At least one continuous pause of N minutes that **starts inside a time window** (e.g. 11:00–14:00). |
| Tolerance | Brazilian labour-law style: up to 5 minutes per clock mark, at most 10 minutes a day, ignored. Both numbers configurable. |
| Time outside the schedule (salaried) | Shown as a daily and monthly balance (extra or short), for information only; pay does not change. |
| Hourly staff and schedules | Hourly staff have free hours; compliance is a policy setting, so anyone on a policy with an enforced schedule is checked. |
| Leave and holidays in the statement | "Hours to post" is worked time only; leave and holiday days are listed separately. |
| Finance employee's access | A new role, `finance`: sees only the hours statement of hourly staff, with history and the spreadsheet; marks lines as posted. No pay rates, salaries, screenshots, apps or settings. |
| After the email | Finance marks each line "Posted", optionally with the value actually posted and a note. The next carry-over starts from the posted value. |
| Breaches of the schedule | Shown on a new Schedule screen and in a block of the existing daily summary (18:30). No new real-time alert. |
| Email transport | Amazon SES through its SMTP endpoint. SMTP becomes editable on Settings → Notifications, with a test email. |

## 3. Approach

New modules beside the existing ones; the calendar-month payroll and month
closing stay as they are. Presence enters the existing daily roll-up, so
targets, pace, payroll, reports and the tray follow without code changes,
because all of them already read the credited time.

Rejected: moving the whole system (monthly targets, monthly summary, month
closing) to cutoff periods — it touches everything and the salaried staff
are paid by calendar month. Also rejected: computing the statement on the
fly without storing it — without a stored copy of what was sent and posted
there is no way to carry late corrections forward.

The work is split into four deliveries, each shippable on its own, in this
order:

1. Mail foundation
2. Presence measure
3. Schedule compliance
4. Pay-period hours statement

## 4. Delivery 1 — mail foundation

**Mail module.** The SMTP sender currently lives inside the alerts module
although alerts, the daily summary and the month-close report all use it.
It moves to its own `mail/` module; behaviour is unchanged.

**SMTP on screen.** A new settings subject, `smtp`, on Settings →
Notifications: host, port, TLS mode, user, password (write-only, never sent
back to the screen), sender address. Same precedence as every other
setting: saved on screen › environment (`SMTP_*`) › nothing. Saving rebuilds
the transport without a restart. A "Send test email" button sends to the
signed-in owner and shows the outcome, including the server's error text.
The "Use the .env value" action applies as on the other cards.

**Recipients per kind of email.** A settings subject listing extra
addresses per kind: alerts, daily summary, weekly summary, month closed,
hours statement. Default for each kind is today's rule (explicit
`DIGEST_EMAIL_TO`, otherwise active owners). The hours statement goes to
active `finance` users plus its extra addresses. Managers never receive
emails that carry everyone's figures (today's rule stays).

**Email language.** A small server-side catalog (English, Brazilian
Portuguese, Spanish) used by the emails of this project, in the company's
default language (Settings → Company & region). Translating the older
emails, Telegram, PDF and Excel is not part of this work.

## 5. Delivery 2 — presence measure

**Policy fields.** `hoursMeasure` (active | presence, default active) and
`presenceGapMin` (default 15, between 1 and 120).

**Rule.** Take the day's active stretches, in order; join two neighbouring
stretches when the gap between them is at most the threshold. Presence is
the total length of the joined blocks. Example: active 08:00–12:00 with
several 5-minute pauses, nothing from 12:00 to 13:10, active 13:10–17:00
gives 3 h 50 + 3 h 50 = 7 h 40. Stretches from two devices are merged first,
as today, so two computers never count twice. The rule is a pure function
next to the existing daily summary rules.

**Storage.** The daily summary gains `presenceSec`. Credited time becomes
"the policy's measure plus adjustments". Active (worked) time is still
stored and shown as information.

**Changing the measure.** Saving a policy with a different measure marks the
open months of its staff for recount (the existing dirty-summary mechanism).
Closed months never move.

**Screens.** Policy form: the measure and the threshold, with one line
explaining each. Wherever hours are shown for a person on a presence
policy, a small note says "presence"; active time stays visible in the day
detail.

## 6. Delivery 3 — schedule compliance

**Policy fields.** `scheduleEnforced` (default off). When on, the policy
uses: start and end of the day (the existing office-hours fields, whose
meaning widens from "when alerts care" to "the expected schedule"), break
minutes (existing field), break window start and end (new), tolerance per
mark (default 5) and per day (default 10). Validation: end after start; the
window inside the day; break shorter than the day.

**Rule, per workday** (pure function, input = the day's presence blocks and
the policy):

- Arrival = start of the first block; leaving = end of the last block.
- Late = arrival minus start, when above the per-mark tolerance.
- Early leave = end minus leaving, when above the per-mark tolerance.
- When the raw late minutes plus the raw early-leave minutes exceed the
  daily tolerance, both are reported, even if each stayed within the
  per-mark tolerance.
- Break = the longest gap between blocks that starts inside the break
  window. Breaches: break shorter than the minimum (short break); no gap
  starting in the window (no break).
- No activity on a workday = no-show.
- Balance = presence minus (scheduled day minus break), in minutes,
  positive or negative, information only.
- Weekly days off, holidays and recorded leave are not checked.

**Storage.** A new table, one row per person per day: arrival, leaving,
break start, break minutes, late minutes, early-leave minutes, balance
minutes, and the list of breaches. Written by the same job that refreshes
the daily summary (every 15 minutes and at day close), so screens and the
digest only read it.

**Schedule screen** (owner and manager). Pick a person and a month; a row
per day with arrival, leaving, break (start and length), late, early leave
and balance; breaches highlighted; month totals at the top (breach count by
kind, total balance).

**Daily summary block.** The 18:30 summary gains "Schedule today": one line
per breach (who, what, by how much). Owners and managers only, as the
summary is today.

## 7. Delivery 4 — pay-period hours statement

**Settings.** A new subject, `payPeriod`, on a new "Hours statement" card:
cutoff day (1–28 or "end of month"), send time (default 07:00), extra
recipients. Default "end of month" keeps generic installs on the calendar
month; production sets 25.

**Periods.** A period is named by the month its cutoff falls in: with cutoff
25, period "2026-10" runs from 26 September to 25 October inclusive. With
"end of month" it is the calendar month. Period boundaries are work dates in
the company zone; daylight-saving changes need no special handling because
days, not hours, bound the period.

**Who is included.** Everyone who was paid hourly on any day of the period,
read from the pay terms history, with the range cut at joining and leaving
dates.

**Tables.**

- Pay periods: label (unique), start date, end date, when the snapshot was
  taken, delivery status (pending, sent, failed, nobody to send to), last
  delivery error, delivery attempts.
- Pay period lines, one per person: measured seconds (credited time inside
  the period at snapshot time), carry-in seconds, minutes to post, leave
  days, holiday days, days with no data, posted minutes (empty = same as to
  post), posted by, posted at, note.

**The carry-over, as a running ledger.** At snapshot time, for each person:

- carry-in = (credited time, as it stands now, over every earlier period
  already sent for that person) minus (the minutes posted for those periods,
  using "to post" when nothing different was recorded, in seconds);
- minutes to post = (measured + carry-in) in whole minutes, rounded down.

Consequences, each covered by tests: a correction to any earlier sent day
shows up exactly once in the next statement; leftover seconds from rounding
are never lost; a posted value different from the proposal is corrected in
the next statement; the first statement has no carry-in. A negative result
is kept as negative and flagged.

**The job.** Runs every hour at minute 10, company zone. A pure rule decides
whether a period is due: the period has ended, the send time of the day
after the cutoff has passed, and the period has no snapshot yet. Before the
snapshot it recounts the daily summaries of the period, so late uploads from
the last day are in. The unique period label makes a double send
impossible. If the server was down at 07:00 the statement goes out at the
next hourly run.

**Delivery.** If the snapshot was taken but the email failed, the job retries
every hour, up to 24 attempts, then raises a delivery-failed alert to the
owner. No hourly staff: the period is recorded, no email. SMTP not
configured: the snapshot is taken and the screen says the email was not
sent. The owner can resend a period from the screen; a resend sends the
stored snapshot again and never takes a new one.

**The email** (company language; Portuguese in production).

- Subject: company name, the period's dates, "hours to post".
- Body (plain text and simple HTML): one line per person with hours to
  post as "H h MM min", the carry-in it includes, leave and holiday days;
  warnings: workdays with no data at all, negative results; a link to the
  screen.
- Attachment: a spreadsheet with a summary sheet and a day-by-day sheet per
  person (arrival, leaving, presence, active time, adjustments).
- No pay rates and no money anywhere in it.

**Hours statement screen** (owner and finance).

- Period picker; the running period appears as "in progress" with the
  partial figures, clearly marked as not final.
- Table: person, hours in the period, carry-in, **to post**, leave and
  holidays, status (to post / posted / posted with a different value).
- "Posted" button per line, with an optional different value and a note;
  can be undone until the next period's snapshot is taken (after that the
  value is part of a carry-over and is locked).
- Each line opens the person's day-by-day detail for the period.
- Spreadsheet download; delivery status and "Resend" (owner only).

**The finance role.** Added to the role list. Allowed: the hours statement
screen and its endpoints, its own Account page. Everything else answers
403; the menu shows only the hours statement, which is also its home page.
Finance logins are created on Staff like the other portal logins. Marking a
line posted is written to the audit log.

## 8. Out of scope

- Posting into Agilize (manual by decision).
- Per-weekday schedules (different hours on different days).
- Real-time alerts for schedule breaches.
- Translating the existing English emails, Telegram, PDF and Excel output.
- Paying overtime to the salaried employee.

## 9. Testing

- Pure rules, unit-tested: presence joining (thresholds, two devices,
  midnight cut); schedule compliance (each tolerance case, break split in
  two, break starting outside the window, early arrival, no data, day off);
  period ranges (cutoff 25, "end of month", February, cutoff day in a
  daylight-saving change); the due rule (before time, after time, server
  down, already sent); the ledger (late correction, leftover seconds,
  different posted value, joining mid-period, first period, negative).
- Integration on the test database: a full statement run with a fake
  mailer; resend; retries and the alert; the finance role refused on every
  other endpoint; SMTP settings precedence and the test email.
- Dashboard: the two new screens, the policy form fields, the menu per
  role, translations present in the three languages.

## 10. Rollout

- One additive migration per delivery; every new field defaults to today's
  behaviour, so deploying changes nothing until switched on.
- After deploy, in production: switch the relevant policies to presence,
  enforce the schedule on the fixed-schedule policy, set the cutoff to 25,
  create the finance login, set up SMTP (SES) and send a test email.
- Infra side: only the SES SMTP credentials, if they go in the environment
  instead of on screen; the sending domain verified in SES (DKIM, SPF,
  DMARC) and the account out of the SES sandbox.
- The architecture map (docs/ARCHITECTURE.md) is updated in the same
  commits that add the modules.
