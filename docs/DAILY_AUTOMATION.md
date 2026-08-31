# Daily Operational Loop

The Daily Operational Loop is the scheduler-ready orchestration layer above the existing Daily Runner:

```text
daily:auto
  -> Daily Runner / discovery
  -> current-run eligibility and ranking
  -> deterministic deep evaluation of new SHORTLIST jobs
  -> review-only packages for new VALID APPLY evaluations
  -> controlled Sheets pull and projection push
  -> notification decision
  -> optional email notification
```

It does not duplicate discovery and does not apply, submit, contact recruiters, operate a browser, or send outreach. SQLite remains authoritative. Operational runs and notification deliveries are persisted separately from discovery runs.

## Scheduler entrypoint

```bash
npm run daily:auto
npm run daily:auto -- --json
npm run daily:auto -- --dry-run
```

`--dry-run` is side-effect free: it does not create a registry run, back up, scan, call Google, or contact the email provider. The macOS hardening layer can invoke `npm run daily:auto -- --scheduled --json`; see `docs/LOCAL_PRODUCTION.md`.

The original `npm run daily` remains the base discovery command and keeps its existing lifecycle, locking, recovery, and exit-code contract.

## Operational state

Migration 008 adds:

- `operational_runs`: overall status, discovery run ID, stage counts, structured summary, errors, sheet result, and notification decision/result.
- `notification_deliveries`: one delivery record per operational run and channel.

Terminal statuses are `SUCCESS`, `PARTIAL`, and `FAILED`. Exit codes are respectively `0`, `2`, and `1`. Reusing a terminal operational run ID returns its stored result without rerunning stages or sending another notification.

## Notification rules

Email is sent only when at least one condition holds:

- one or more new jobs became `SHORTLIST` in this operational run;
- one or more new valid packages became ready;
- an error requires human attention, such as Daily Runner failure, registry-stage failure, or unavailable Sheets sync.
- the bounded active set is non-empty but produces zero shortlist (`QUALITY_ATTENTION`); this is a quality alert, not a run failure.

Recovered/provider diagnostics classified as informational remain in the summary but do not independently trigger email. Runs without changes send nothing.

Email content contains counts, up to five sorted recommendations, concise reasons, relevant job/dashboard links, and system status. It never includes complete logs.

## Secure email configuration

Notifications are disabled unless explicitly enabled:

```dotenv
CAREER_OPS_NOTIFICATIONS_ENABLED=true
CAREER_OPS_EMAIL_PROVIDER=resend
RESEND_API_KEY=replace_with_secret
CAREER_OPS_EMAIL_FROM=Career Ops <career@brunova.mx>
CAREER_OPS_EMAIL_TO=jorgeaveraf@gmail.com
CAREER_OPS_SHEET_ID=your_spreadsheet_id
GOOGLE_SHEETS_AUTH_MODE=workspace_broker
CAREER_OPS_DASHBOARD_URL=https://docs.google.com/spreadsheets/d/your_spreadsheet_id/edit
```

No credential is embedded in source code. Keep secrets in `.env` or the future machine's secret environment; `.env` is gitignored. The configured `brunova.mx` sender domain must be verified with the provider before production use.

The built-in email adapter uses Resend's REST `POST /emails` API and an `Idempotency-Key` derived from the operational run ID, following the [official send-email contract](https://resend.com/docs/api-reference/emails/send-email). SQLite also enforces one email delivery per run. No email was sent while developing this increment.

## Operational behavior

Ranking is scoped to observations attributed to the discovery run and current policy/rule versions. Evaluation and package generation are deterministic—no LLM API is called by `daily:auto`. Existing artifact identity rules prevent duplicate assessments, evaluations, and packages.

Sheets sync imports only the allowlisted human-owned fields, then rebuilds and pushes the authoritative projection. A Sheets failure is recorded as attention-required and does not turn the spreadsheet into a fallback datastore.

Known limitations: the prepared scheduler is not installed automatically; Resend/domain credentials still require production provisioning; OAuth access-token refresh is not implemented; processing is sequential; and delivery idempotency at the provider lasts 24 hours while SQLite retains the permanent run-level record.
