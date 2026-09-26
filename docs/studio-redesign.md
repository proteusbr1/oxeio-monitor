# Studio dashboard redesign

Approved direction: Studio (26 September 2026).

## Implemented

- Shared application shell: desktop sidebar, grouped role-filtered navigation,
  account identity, page breadcrumb, theme switch and sign out. Mobile keeps
  every permitted destination in a horizontally scrollable navigation row.
- Live Board: four summary cards, a seven-day Designs/Hours chart, current team
  status and a full-width staff table. Worklog and Reports remain directly linked.
- Existing hourly activity, app usage, leader windows, monthly progress and
  fewest-hours panels remain available below the overview.
- Design totals count completed designs, including a genuine zero when designers
  are present. Unknown tracking days keep dashed marks and em dashes.
- Per-panel loading and failure states retain the last successful response and
  show a retry action. The main board keeps its refresh time visible.

The design uses the existing API contracts, role restrictions, timezone and
polling intervals (15 seconds for status, two minutes for summaries). No screenshot
polling was added to the Live Board. Worklog, payroll and tracking calculations
are unchanged.

## Workspace prerequisite

Before this work, `admin.ts`, `reports.ts` and `targets.ts` were missing while
their implementations existed under `(1)` filenames. Small re-export files now
restore the canonical import paths without editing those local implementations.
The unrelated server filename changes and existing documentation edits were left
as found.

## Validation

- Production build and TypeScript pass; Vite reports a bundle-size warning.
- ESLint passes. All 256 existing web tests pass.
- Built React app checked with isolated sample API responses: chart toggle,
  desktop dark mode, 390px mobile light mode, manager visibility, empty board
  and request failure. The mobile page has no horizontal document overflow.
- Preview fixtures are outside the repository and are not in the production build.
- Live production data and deployment have not been verified or changed.
