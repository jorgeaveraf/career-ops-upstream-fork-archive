# Autonomous Outreach Execution

Career Ops V4.3 executes a reviewed pursuit plan after two independent human decisions. The application remains primary; outreach supplements the canonical application destination and never replaces an ATS/platform submission unless the posting explicitly requires email application.

## Platform-first application

Discovery source and application destination are distinct. An Indeed link may resolve to Greenhouse, Ashby, or a company careers form; that authoritative destination remains the primary route. The activation plan binds the destination, application channel, current package ID/version, contact, outreach channel, timing, draft version, and hash. An email application to the posting’s specified address is application execution, not supplemental outreach, and the planner suppresses a redundant second email to the same person.

## Best contact

Contact Intelligence ranks one primary contact: role-linked recruiter, hiring manager, team/function leader, relevant Talent Acquisition, founder/leader for a smaller company, official general recruiting route, public LinkedIn route, then none. Identity, title, relevance, confidence, public provenance, and an appropriate public route are required. A secondary contact is evidence/fallback only; the default execution ceiling is one contact/action per job.

## Candidate Gmail

Candidate email uses Gmail API, never browser clicking when the API is available. It has a dedicated OAuth credential file under the user-owned `data/auth/candidate-gmail/` directory and verifies Gmail `users/me/profile` is exactly `jorgeaveraf@gmail.com` before every send/check. The Brunova Workspace/GCP credential chain is untouched. `career@brunova.mx`, Resend, and `fubifo@gmail.com` cannot satisfy the sender check.

Run `npm run candidate-gmail:auth -- authorize` once, choosing `jorgeaveraf@gmail.com`; the command resolves Chrome profile `Jorge` by its exact Local State name and opens consent in that profile rather than the default browser identity. Inspect without sending using `npm run candidate-gmail:auth -- status`. A send is bound to job, application context, contact, recipient, channel, subject/body, message/plan version and hash, timing, authorization, and idempotency key. Gmail message/thread IDs and sent time are persisted. A 5xx/network-ambiguous result becomes `VERIFICATION_REQUIRED`; it is never blindly retried.

## LinkedIn

LinkedIn execution uses the existing macOS managed-window driver with logical profile Jorge, a separate session lock, and tabs created inside the owned Career Ops window. User-owned tabs are never claimed or closed. The exact Contact Intelligence profile URL, displayed identity, and company/role relevance are checked before selecting `DIRECT_MESSAGE`, `CONNECTION_REQUEST_WITH_NOTE`, or `INMAIL` based on the available UI.

CAPTCHA, MFA, login, account restriction, rate-limit warnings, unexpected verification, missing safe message mode, identity mismatch, or relevance mismatch stop execution. A challenge becomes `NEEDS_YOU`/`EXTERNAL_ACTION_REQUIRED`; uncertain post-click state becomes `VERIFICATION_REQUIRED`. Neither state retries or falls back to another contact. Observable message, pending-request, toast, or conversation evidence is required for `SENT`.

## Unsupported channels

X/Twitter, Slack, Discord, unsupported Wellfound/community messaging, contact forms, GitHub, and other social routes have no execution worker. When appropriate they produce `MANUAL_OUTREACH_RECOMMENDED` with contact, public URL, suggested message, reason, timing, and “Send suggested message manually.” GitHub issues/discussions and customer-support routes are never repurposed as outreach.

## Authorization and timing

`APPROVE_TO_APPLY` authorizes one application only. `APPROVE_OUTREACH` authorizes one exact current outreach plan only. A material job, package, destination, contact, channel, draft, hash, or timing change makes the approval stale.

`BEFORE_APPLICATION` is eligible only when explicitly planned. `IMMEDIATELY_AFTER_APPLICATION` waits for observable `APPLICATION_CONFIRMED`; `NEXT_BUSINESS_DAY` schedules 9:00 AM using IANA `America/Mexico_City` business-day semantics. The recurring operational watcher drains due schedules, so a second Sync Jobs action is unnecessary. Unknown/failed application results cannot release wording that claims an application was submitted.

## Registry, idempotency, and rates

Schema 30 persists authorization, schedule, sender/recipient, subject, provider, Gmail message/thread or LinkedIn conversation identity, send/verification/response times, outcome, attempt count, blockers, and immutable canonical workflow events. States project as `NONE`, `READY`, `AUTHORIZED`, `SCHEDULED`, `SENDING`, `SENT`, `NEEDS_YOU`, `VERIFICATION_REQUIRED`, or `FAILED`.

Safety ceilings are five outreach executions per watcher/run, ten candidate emails per Mexico-local day, and ten LinkedIn actions per Mexico-local day. These are ceilings, not targets. TODAY’s curation normally produces much lower volume.

## Responses and follow-up

Bounded Gmail checks use the stored recipient/thread and surface `RESPONSE_RECEIVED`; they never auto-reply. LinkedIn conversation identity is retained for future bounded checks, without aggressive polling. A confirmed application/outreach may recommend a five-business-day follow-up. Sending a second follow-up requires a new exact authorization unless a future plan explicitly defines one narrow follow-up capability.

## Operator experience

TODAY shows the application destination, primary contact, recommendation, channel, timing, outreach status, and suggested message before approval. Confirmed applications leave TODAY as before. APPLICATIONS preserves application confirmation plus the pending/sent outreach, contact, channel, sent time, follow-up date, and outcome. Notifications remain aggregated and are reserved for meaningful confirmation, failure, verification, response, or human-only blockers.
