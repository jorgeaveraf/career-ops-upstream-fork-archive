# Human Control Plane

The Human Control Plane is a Google Sheets operational dashboard over the local Job Registry. SQLite in `data/career.db` remains the source of truth; the spreadsheet is a projection plus a narrow, audited input surface for human decisions.

## V3F human-touchpoint audit

This audit was completed before the V3F implementation. `TODAY` is the universal attention queue; the other tabs remain the bounded input surfaces named below. An item leaves attention only when its authoritative domain condition changes.

## V4 human projection

The operator sees three stages: `DISCOVERED`, `PREPARING`, and `READY`. `APPLIED` is not a TODAY stage: positive submission confirmation moves the row to `APPLICATIONS`. Visible statuses are `WAITING_FOR_YOU`, `WORKING`, `QUEUED`, `READY`, `BLOCKED`, and `ON_HOLD`. Technical workflow stages and statuses remain persisted for recovery, events, idempotency, and diagnostics, but are hidden from the primary TODAY view.

The first scanning columns are Company, Role, Stage, Status, Action, Recommendation, Rank, and Location. Attention details and the contextual yellow input follow only when needed. All `WAITING_FOR_YOU` states use amber attention semantics; queued/working states use purple/blue, blocked uses red, inactive/history uses gray, and green is reserved for verified positive completion.

| Touchpoint | Current location | Sheet-capable? | Target surface | Required human action | External UI unavoidable? | Lifecycle result |
|---|---|---:|---|---|---:|---|
| New high-value opportunity | TODAY / persisted candidate snapshot | Yes | TODAY — `DECISION_REQUIRED` | `REJECT`, `HOLD`, or `NEXT_STAGE` | No | Reject, retain, or enqueue enrichment |
| Package ready | Enrichment request + artifact manifest | Yes | TODAY — `REVIEW_REQUIRED` | Review exact package; `APPROVE_TO_APPLY`, `HOLD`, or `REJECT` | No | Authorize, retain, or reject |
| Exact submission authorization | Application authorization state | Yes | TODAY — `APPROVAL_REQUIRED` | Approve the displayed package/version/plan | No | Create the existing bounded authorization; never auto-apply |
| Application question | Execution blocker | Yes, for non-secrets | TODAY — `ANSWER_REQUIRED` | Enter the requested fact in `Human Answer` | No | Persist provenance and safely resume the blocked execution |
| Multiple application questions | Execution blockers | Yes, one bundled opportunity row | TODAY — `ANSWER_REQUIRED` | Answer the stable question bundle | No | Answers retain stable question identity and clear independently |
| Ambiguous submit result | Execution `VERIFICATION_UNKNOWN` | Yes | TODAY — `VERIFICATION_REQUIRED` | `CONFIRMED_APPLIED`, `NOT_APPLIED`, or `KEEP_UNKNOWN`; optional notes | Sometimes, to inspect ATS/email | Confirm applied, close safely as not applied, or retain ambiguity; never retry |
| CAPTCHA / MFA / authentication | Execution or community blocker | Partly | TODAY — `EXTERNAL_ACTION_REQUIRED` | Complete the named action outside Career Ops | Yes | Sync resumes only where the existing workflow supports it |
| Application outcome | Confirmed application | Yes | APPLICATIONS | Set supported outcome, interview date, next action, or notes | No | Audited post-application state update |
| Follow-up | Follow-up record / application state | Yes | TODAY — `FOLLOW_UP_REQUIRED`; edit in APPLICATIONS/FOLLOW_UPS | Set date/action/notes or complete/cancel | No | Follow-up remains human-controlled; no outreach |
| Contact review | Contact intelligence result | Yes | TODAY when actionable; details in CONTACTS | Review contact result/status/notes | No | Preserve one contact roll-up row per job; no outreach |
| Community join question | Community workflow blocker | Yes, for non-secrets | TODAY attention summary; answer/decision in COMMUNITIES | Answer or choose membership action | Sometimes | Imported only by `Sync Communities` |
| Facebook/platform challenge | Community workflow blocker | Partly | TODAY — `EXTERNAL_ACTION_REQUIRED`; details in COMMUNITIES | Complete challenge externally | Yes | Never bypass challenge or store credentials |
| Operational escalation | Operational signal | Yes, as status/attention | TODAY attention summary + SETTINGS status + V3D email | Follow the bounded recommended action | Sometimes | V3E closes only after authoritative recovery |
| Manual command result | Workflow command/event | Yes | TODAY feedback / SETTINGS | None on success; inspect failure | No | Success stays in Sheet; failure remains V3D-actionable |
| Notifications | Durable V3D outbox | Not an input | Email + SETTINGS summary | Open Sheet only when actionable | No | Delivery remains deduped and auditable |
| Daily completion | Terminal daily operational run | Not an input | One concise email + SETTINGS | None when attention count is zero | No | Exactly one summary per Mexico City local date |

The audit found four V3F gaps: the old `HUMAN ACTIVE` lane mixed autonomous work with human work; verification had no Sheet resolution contract; artifacts were labeled but not guaranteed to be conveniently accessible; and successful daily completion had no durable once-per-day summary. V3F closes those gaps without adding a second datastore, a new menu action, or a broader automation boundary.

## Ownership boundary

Career Ops owns job facts, eligibility, scores, evaluations, packages, contact evidence, URLs, identifiers, and sync metadata. A pull rejects edits to those fields.

The human owns only:

- `TODAY`: Human Decision, optional Rejection Reason, Application Decision, Human Answer, Human Resolution, Resolution Notes, Follow-Up Date, Follow-Up Action, and Notes.
- `PIPELINE`: Human Decision and optional Rejection Reason.
- `RESEARCH`: Human Notes.
- `APPLICATIONS`: Interview Date, Next Action, Outcome, and Notes.
- `CONTACTS`: Outreach Status and Notes.
- `FOLLOW_UPS`: Date, Action, Related Job, Status, and Notes.

Accepted inputs are appended to `human_actions` and materialized in `human_field_state`. Rejected edits are also recorded for audit. Push merges human-owned cells and preserves follow-ups created in the sheet, so refreshes do not erase pending input.

## Human Decision lifecycle

- `NO_ACTION`: todavía no hay decisión; Career Ops continúa normalmente.
- `REJECT`: no quiero esta oportunidad. Sale inmediatamente de la cola activa y del TOP; el job, observaciones, decisión, Rejection Reason y Notes se conservan. Se crea feedback auditable y señales futuras separadas de eligibility. Rechazar una vacante no bloquea automáticamente a la empresa.
- `HOLD`: conservar para después. La oportunidad puede permanecer como `HELD_VISIBLE`, consume un slot de la capacidad total, muestra `ON_HOLD`, no cuenta como atención y no crea enrichment. Carryover por sí solo nunca fija una fila para siempre.
- `NEXT_STAGE`: en DECIDE crea exactamente una solicitud `PENDING`; durante preparación mantiene un pin no accionable; en `READY_FOR_REVIEW` requiere la decisión de cierre permitida. Nunca equivale a `APPROVE_TO_APPLY` ni autoriza aplicación u outreach.

`REVIEW` y `APPROVE` siguen aceptándose al importar workbooks antiguos y se migran explícitamente a `HOLD` y `NEXT_STAGE`. Las columnas Career Ops-owned `Decision Outcome` y `Enrichment Status` muestran el lifecycle persistido sin inspeccionar SQLite. Una solicitud activa se cancela en el siguiente boundary seguro si la decisión deja de ser `NEXT_STAGE`. En `APPLICATIONS`, `APPROVE_TO_APPLY` queda reservado para V2D y no ejecuta acciones en V2B.

El texto de Notes se guarda exactamente. Rejection intelligence puede crear `OBSERVATION`, `SOFT_SIGNAL` y un `POLICY_CANDIDATE` auditable; nunca crea `HARD_RULE` automáticamente ni modifica la Candidate Selection Policy. Ranking expone por separado el ajuste, sus razones y las referencias de feedback.

## Decision-first workbook contract

The workbook starts with a Career Ops-managed `README`, followed by the seven projected tabs: `TODAY`, `PIPELINE`, `RESEARCH`, `APPLICATIONS`, `CONTACTS`, `FOLLOW_UPS`, and `SETTINGS`. `SOURCE_METRICS` is an optional technical tab placed after the human views. README is initialized once and is not regenerated by daily push/sync operations.

Headers are frozen, filters are enabled, human inputs use a consistent light input background plus a `Human input — safe to edit` header note, enum inputs keep dropdown validation, user-facing contract columns are visible, and technical identity/hash columns are hidden. Career Ops-owned headers carry an ownership note. Existing warning-only ranges remain advisory; the initializer does not add hard protections that could block API synchronization.

`TODAY` is the V4.6 Human working set, ordered as verification, answer, approval, review, decision, governed background work, and explicit holds. Stage, Status, and Action provide the primary mental model; Attention Type, Reason, Question, and Allowed Actions provide exact context and do not rely on color. The Apps Script source adds exactly two **Career Ops** actions: **Sync Jobs** and **Sync Communities**.

`TODAY_TARGET = 10` is total capacity: actionable, pinned, and held-visible rows each consume one slot. Refill always uses the complete authoritative Registry candidate universe and the single `selectTodayMembership()` policy. Fewer than ten is valid only with deterministic `EXHAUSTED` evidence; missing required processing is `BLOCKED`. `PIPELINE` contains the bounded active candidate set (maximum 100) plus meaningful application lifecycles. `RESEARCH` consolidates open evidence needs. The Sheet is never candidate authority.

Ranks, movement, selection state, evidence completeness, and research needs come from the latest persisted candidate snapshot. The projection is rebuilt from current registry state, not from a historical core-run cutoff. `ACTION_READY` is a strict final state: the candidate must be Active/CARRYOVER with trustworthy URL identity, a concrete non-pool posting, supported geography, a meaningful description, a known compatible employment model, an `ELIGIBLE/SHORTLIST` assessment, no critical conflict or hard reject, a `VALID/APPLY` Deep Evaluation, and a `VALID` review-only package. Before those artifacts exist, a sufficiently evidenced candidate is `DEEP_EVALUATION_READY` or `PACKAGE_GENERATION_READY`. Missing compensation, schedule, or company market remains visible as `UNKNOWN` and does not block by itself; negative or contradictory evidence still blocks.

Human values follow stable entity IDs, never row positions, company names, or titles. They therefore survive sorting, row movement, temporary disappearance, and reappearance. `APPLICATIONS` contains every NEXT_STAGE enrichment lifecycle, including a useful `DO_NOT_APPLY` result without a package; links point to private gitignored artifacts. `CONTACTS` only contains evidenced contacts. `SOURCE_METRICS` labels `RUN` versus `LIFETIME` scope and separates source from strategy.

Manual V2B operation:

```bash
npm run application:enrich -- pending
npm run application:enrich -- dry-run
npm run application:enrich -- next
```

The dry run does not navigate or write. The worker keeps its rich internal lifecycle, but `READY_FOR_REVIEW` may be persisted only after the shared `ApplicationReadinessValidator` proves the evaluation, path, required artifacts, current package, evidence, blockers, mandatory facts, and Contact Intelligence policy. A failed invariant remains human `PREPARING / BLOCKED`; it cannot project `READY`.

## Commands

```bash
# Inspect the local projection without Google credentials
npm run control-plane -- preview --sheet "$CAREER_OPS_SHEET_ID"

# Create/format missing tabs, then push the projection
npm run control-plane -- init --sheet "$CAREER_OPS_SHEET_ID"
npm run control-plane -- push --sheet "$CAREER_OPS_SHEET_ID"

# Import only allowlisted human inputs
npm run control-plane -- pull --sheet "$CAREER_OPS_SHEET_ID" --user "your-name"

# Pull, rebuild from SQLite, and push in one explicit operation
npm run control-plane -- sync --sheet "$CAREER_OPS_SHEET_ID" --user "your-name"

# Print the bound Apps Script source for installation or review
npm run control-plane -- apps-script

# Inspect rejection memory and the V2B queue
npm run feedback -- summary
npm run feedback -- rejected
npm run feedback -- signals
npm run enrichment-queue -- pending
```

Google operations use the pinned headless `workspace_broker` provider; `CAREER_OPS_SHEET_ID` can replace `--sheet`, and `CAREER_OPS_DB` can replace `--db`. Cloud Run performs IAM signing and DWD as `brunova@brunova.mx`; local user ADC is forbidden in production. See `GOOGLE_SHEETS_AUTH.md`.

The bound Apps Script cannot access local SQLite directly. Its two signed commands travel through the V3A gateway/subscriber to the canonical local workflows; they do not create a second datastore. Email and the daily summary are notification-only. There is still no auto-apply, automatic outreach, or challenge bypass. Scheduled Facebook discovery is read-only and performs no social mutations.

## Synchronization and recovery

Each push or pull appends `sheet_sync_runs` and updates `sheet_sync_state`. Projection rows carry stable entity IDs and Career Ops hashes. Repeating a push is sheet-idempotent, repeating an already imported decision is safe, and returning to a previously used decision restores that desired state correctly.

If a pull reports rejected changes, restore the Career Ops-owned cell by running `push` after reviewing the audit result. If sync stops midway, rerun `sync`; the allowlist and idempotency keys prevent duplicate state. Do not treat a sheet value as authoritative until pull has accepted it into SQLite.

## V3F attention and resolution contract

`HumanAttentionService` is a read/control model over SQLite and canonical workflow events. It exposes `getAttentionItems()`, `getAttentionForJob(jobId)`, `getAttentionCounts()`, `validateHumanInput(...)`, and `resolveImportedAction(...)`. It never becomes a second source of truth.

The allowlist is deliberately small: `DECISION_REQUIRED`, `REVIEW_REQUIRED`, `ANSWER_REQUIRED`, `APPROVAL_REQUIRED`, `VERIFICATION_REQUIRED`, `FOLLOW_UP_REQUIRED`, and the unavoidable `EXTERNAL_ACTION_REQUIRED`. Sensitive authentication is never accepted in Human Answer.

For `APPLICATION_VERIFICATION_UNKNOWN`, `Human Resolution` accepts only:

- `CONFIRMED_APPLIED`: records human provenance, transitions canonically to APPLIED, populates APPLICATIONS, and closes the matching V3E ambiguity signal.
- `NOT_APPLIED`: closes the ambiguous execution as CANCELLED, places authorization on HOLD, and requires a new exact authorization before any later attempt.
- `KEEP_UNKNOWN`: records the choice but preserves the protected ambiguity and V3E signal.

There is no `RETRY` resolution. A repeated Sync with unchanged input does not duplicate actions or events. Invalid input leaves the workflow waiting and projects a plain-language error in Last Activity.

## Artifact access

Resume and Cover Letter cells are clickable `HYPERLINK` formulas. Existing Drive/web URLs are preferred. When a package only has private local files, the loopback-only artifact service (`127.0.0.1:4319`) provides an exact request/job/hash-bound URL. It never exposes filesystem paths, rejects non-current packages with HTTP 410, serves only the two allowlisted PDFs, and is available only on the Career Ops Mac.

## Daily completion summary

The 17:00 Application Enrichment boundary enqueues `DAILY_COMPLETION_SUMMARY` after a valid terminal daily operational run. Metrics come from the operational run, candidate snapshot, attention service, packages, confirmed applications, and open V3E signals—not from Sheet cells. Dedupe is durable on notification type + `America/Mexico_City` local date + recipient. A zero-result day still sends once; a partial run says `COMPLETED_WITH_LIMITATIONS`.

Manual Sync Jobs/Sync Communities success never sends email. User-initiated `COMMAND_FAILED` remains actionable through V3D. SETTINGS stays compact: Career Ops Status, Needs Your Attention, Notifications Enabled, Daily Summary Enabled, Last Daily Summary, and Last Notification.

Normal operation needs neither repository access nor chat. CAPTCHA, MFA, login, and platform challenges remain explicit `EXTERNAL_ACTION_REQUIRED` cases and are never bypassed.
