# Facebook Communities (V4)

Career Ops includes bounded Facebook post monitoring in the daily Browser Research window. It reads recent posts only in already joined or previously approved communities, classifies `JOB`, `CONTRACT`, `FREELANCE`, `HIRING_SIGNAL`, `NOT_OPPORTUNITY`, or `UNKNOWN`, and normalizes concrete opportunities through the same Job Registry, dedupe, eligibility, and ranking boundaries as every other source.

Source provenance retains the community, post ID/URL, poster public identity when relevant, extracted text evidence, posted time, geography/remote/employment/compensation signals when present, and confidence. Missing facts stay missing. Incremental post checkpoints prevent daily reprocessing.

Monitoring is automatic discovery; social mutation is not. Daily monitoring performs zero joins, comments, replies, DMs, posts, reactions, or applications. `WANT_TO_JOIN` remains a separate exact human authorization. CAPTCHA, authentication, or challenges are never bypassed, and failure of Facebook does not stop other discovery sources.

## Safety boundary

- Supported: community discovery, read-only group monitoring, post opportunity extraction, and one exact join attempt backed by a persisted `WANT_TO_JOIN` action.
- `WANT_TO_JOIN` authorizes only the canonical URL and entity in that row. The authorization action is durable and can produce at most one click.
- Questions, free-text answers, checkboxes, rules acknowledgements, and ambiguous controls always return `NEEDS_HUMAN`.
- Unsupported: messaging, reacting, commenting, sharing, following, applying, submitting forms, and uploading files.
- Authentication, challenge, CAPTCHA, wrong-page, URL mismatch, and selector-change outcomes stop or degrade the bounded run; they are never bypassed.

## Lifecycle

Discovery creates a community record with Candidate KB hash, strategy revision, query explanation, scores, and source evidence. Recommended private groups enter `JOIN_REQUIRED`. In the `COMMUNITIES` Sheet tab, use:

- `WANT_TO_JOIN`: explicit authorization for **Career Ops → Sync Communities** to inspect and, if safe, click the exact group's Join control once.
- `JOINED`: assert that you completed membership manually; monitoring becomes eligible.
- `SKIP` or `REJECT`: soft-suppress the community from the active Sheet projection while preserving the database record, notes, feedback, and event history. Rediscovery cannot reactivate it.
- `Notes`: durable human context, preserved across projections.

Join outcomes are `JOINED_CONFIRMED`, `JOIN_REQUESTED`, `NEEDS_HUMAN`, `ALREADY_JOINED`, `JOIN_FAILED`, `CHALLENGE`, `AUTH_REQUIRED`, or `POLICY_BLOCKED`. A repeated sync never performs a second click for the same authorization; it may only recheck observable membership or request state.

Monitoring re-verifies observed membership, reads a bounded number of recent posts, and maintains per-group checkpoints. Repeated posts are idempotent. Images are only flagged as `IMAGE_EVIDENCE_PRESENT`; V2C.1 does not perform OCR.

Strong job/contract/freelance posts enter the normal Acquisition and Job Registry boundary as provider `browser:facebook`. They then face the same Candidate Selection rules, including hard company rejects and pool-only handling. A public email found in post text is saved with provenance and can become an evidence-backed V2B application path; it is never contacted automatically.

## Commands

```bash
npm run facebook -- discover-communities --dry-run --max-queries 5
npm run facebook -- discover-communities --max-queries 10 --max-candidates 30
npm run facebook -- communities
npm run facebook -- sync-communities
npm run facebook -- monitor --max-groups 3 --max-posts 25
```

The bound Apps Script menu sends a signed `communities.sync` command through the V3A command gateway. Pub/Sub retains it while the Mac is offline, and the native subscriber dispatches the existing bounded worker after durable local persistence. The worker pulls decisions and notes, applies suppression, processes authorized groups sequentially, and pushes the converged projection. `SETTINGS` is status/audit only, not transport. The CLI command is retained for operations and testing; normal human use is the **Sync Communities** menu item.
