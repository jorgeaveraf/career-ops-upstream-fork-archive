# Application Activation

Career Ops V4.2 turns a completed application package and bounded Contact Intelligence result into one conservative, reviewable application/outreach plan. Planning is deterministic where practical; application submit and outreach remain independent external operations.

## Planner contract

`ApplicationActivationPlanner` consumes the job, valid evaluation, official application path, current application package, Contact Intelligence artifact, company/hiring research, source provenance, candidate preferences, and declared channel capabilities. It produces:

- `applicationStrategy`: `APPLICATION_READY` or `APPLICATION_BLOCKED`, primary application channel/target, exact package/version, artifacts, human questions, and blockers.
- `outreachStrategy`: `OUTREACH_RECOMMENDED`, `OUTREACH_OPTIONAL`, `NO_OUTREACH`, or `OUTREACH_BLOCKED`.
- one primary contact, at most one strongly justified secondary contact, selected channel, timing, reasoning, evidence, human actions, authorization scope, follow-up recommendation, and capability state.
- a hashed, versioned `outreachPlan` persisted as `outreach_plan.json`. Sheet copy is a projection, never the authority.

`APPLICATION_READY` means the safe application package/path exists. `ACTIVATION_READY` additionally means contact research reached a terminal bounded result and the outreach/no-outreach strategy is resolved. TODAY keeps the simple `DISCOVERED → PREPARING → READY` lifecycle.

## Contact and channel ranking

The planner ranks supported evidence in this order: recruiter, hiring manager/team leader, talent acquisition, relevant functional hiring leadership, official general recruiting, then other public profiles. It does not prefer email merely because an address exists.

Supported recommendation channels are:

- `RECRUITER_EMAIL` or `HIRING_MANAGER_EMAIL` only for an explicitly public, evidenced business address.
- `GENERAL_RECRUITING` for an official careers/talent route.
- `LINKEDIN_PROFILE` as a public profile plus human-send draft by default.
- `PLATFORM_MESSAGE` only when an existing capability explicitly declares support.
- `NONE` when the evidence or relevance threshold is not met.

No email patterns are generated or inferred. Invalid or unattributed addresses are not used. One primary route is the default; a secondary contact is retained only when separately high-confidence, and no bulk/mass outreach path exists.

## Relevance and timing

Direct recruiters, hiring managers, and talent-acquisition contacts with HIGH/MEDIUM evidence may be recommended. Official general recruiting is optional. Weak, generic employee, or speculative relevance yields no outreach. A blocked research result yields `OUTREACH_BLOCKED` rather than an invented fallback.

Outreach normally uses `IMMEDIATELY_AFTER_APPLICATION`. `BEFORE_APPLICATION` is reserved for strong explicit evidence and is not selected by the default policy. Post-application plans are ineligible until an observable `APPLICATION_CONFIRMED` event or the exact human resolution `CONFIRMED_APPLIED`; a click or `VERIFICATION_UNKNOWN` is insufficient.

After confirmation, the plan recommends a review in five business days. FOLLOW_UPS may project that recommendation, but V4.2 never sends the follow-up automatically.

## Message generation and truthfulness

The message is selected from the validated application package’s evidence-backed outreach drafts. Recruiter/general email is bounded to roughly 60–120 words. LinkedIn copy is bounded to 300–500 characters. Job/company/contact context may be adapted, but candidate claims retain Candidate KB evidence references. The persisted artifact contains job ID, optional application ID, contact ID, channel, timing, subject, body, evidence refs, version, and stable hash.

Drafts avoid unsupported claims and do not say “I applied” before confirmation. A draft may exist while application verification is unresolved, but execution remains blocked.

## Separate authorization and execution

`APPROVE_TO_APPLY` binds one job, current package, artifact hashes, and application plan. It never authorizes a message. Application execution always records outreach as `NOT_AUTHORIZED` and cannot call a secondary sender.

`APPROVE_OUTREACH` binds one exact job/contact/channel/message version/hash through `outreach_authorizations`. `outreach_executions` adds an idempotency key over job, contact, channel, version, and authorization. `SKIP_OUTREACH` and `HOLD` create no send authority. Application success does not depend on outreach success, and outreach failure cannot roll back an application.

If a transport cannot provide observable confirmation, execution becomes `VERIFICATION_REQUIRED` and is never retried automatically. LinkedIn has no production auto-send transport in V4.2. Candidate Gmail outreach transport is also unavailable unless separately and safely configured; no notification provider is reused as an outreach sender.

## Identity boundary

- Application and justified outreach sender: `jorgeaveraf@gmail.com`.
- Career Ops notification sender: `career@brunova.mx`.
- Platform-signup identity: `fubifo@gmail.com`, prohibited for applications and outreach unless a future, separate explicit exception is authorized.

Identity routing resolves the exact account by purpose. Browser `/u/N` position is not an account identity and is never trusted.

## Effectiveness fields

Contact discovery, recommendation, authorization, send state, response outcome, and application outcome remain separate facts. CONTACTS supports `UNKNOWN`, `NO_RESPONSE`, `REPLIED`, `RECRUITER_SCREEN`, `INTERVIEW`, `REFERRED`, and `NEGATIVE`. A single result does not directly retune ranking.

## Human-time presentation

SQLite, events, logs, API payloads, and hash inputs retain UTC ISO-8601. Normal operator columns and notification time copy use IANA `America/Mexico_City` with concise Spanish presentation such as `29 ago 2026 · 5:00 PM`, `Hoy · 5:00 PM`, or `Ayer · 4:36 PM`. The formatter relies on the IANA database rather than a fixed offset, so historical DST and current Mexico rules are respected.

## Operator flow

For a READY APPLY row, review Why This Role, package links, Application Path, Primary Contact, Outreach Recommendation, Channel, and Timing. Choose `APPROVE_TO_APPLY`, `HOLD`, or `REJECT`. Only when outreach is relevant, separately choose `APPROVE_OUTREACH`, `SKIP_OUTREACH`, or `HOLD`. No outreach value is preselected and no message is sent merely because preparation completed.
