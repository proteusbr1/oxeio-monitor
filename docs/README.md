# docs/

**Start here:** [ARCHITECTURE.md](ARCHITECTURE.md) — the current map of the
code: modules, settings, module switches, roles, deployment and tests. It is
kept up to date with the code.

The other documents come from the original project (ownCoder/oxeio-monitor)
and are written mostly in **Bengali**. They are the design history: useful to
understand *why* something was decided, but not a description of this fork as
it is now. Code comments still cite some of them (for example `ADR-023` lives
in `05-Options-Decisions.md`).

| File | What it is | Language | Still useful for |
|---|---|---|---|
| [01-Planning.md](01-Planning.md) | goals, scope, constraints of the original product | Bengali | background |
| [02-Workflow.md](02-Workflow.md) | how owner, manager and staff use the system day to day | Bengali | understanding the intended flows |
| [03-Project-Map.md](03-Project-Map.md) | the original code map | Bengali | superseded by ARCHITECTURE.md |
| [04-Features.md](04-Features.md) | feature catalogue, including what the product refuses to do (§ L) | Bengali | product boundaries |
| [05-Options-Decisions.md](05-Options-Decisions.md) | architecture decision records (ADR-001…) | Bengali | the reasons behind design choices cited in code |
| [06-Research.md](06-Research.md) | research on capture, idle detection, tooling | Bengali | background |
| [07-Technical-Spec.md](07-Technical-Spec.md) | technical specification: data model, rules, API | Bengali | rules cited in code as "spec §" |
| [08-Gap-Analysis.md](08-Gap-Analysis.md) | known gaps and their fixes (the G-numbers in old comments) | Bengali | history |
| [09-Build-Log.md](09-Build-Log.md) | day-by-day build diary of the original project (14k lines) | Bengali | history, incident details |
| [10-Roadmap.md](10-Roadmap.md) | the original roadmap (R-numbers) | Bengali | history |
| [monitoring-policy-template.md](monitoring-policy-template.md) | a monitoring policy staff can sign | Bengali | adapt to your language and law before use |
| [studio-deployment.md](studio-deployment.md), [studio-redesign.md](studio-redesign.md) | notes on the dashboard redesign and its deployment | English | history |
| [audits/](audits/) | the 26 Sep 2026 system audit and fix tracker | English | history |
| [archive/](archive/) | the very first plan | English | history |
| `media/`, `mockup/` | screenshots and design mockups | — | — |

The deployment manual is [oxeio-monitor/deploy/README.md](../oxeio-monitor/deploy/README.md)
(in English; production for this fork runs on Coolify — see ARCHITECTURE.md).
