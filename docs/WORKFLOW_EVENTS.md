# Canonical Workflow Events

Career Ops keeps operational state in its existing SQLite domain tables. `workflow_events` does not replace those tables and current state is never reconstructed by replaying events. It is the append-only, cross-domain explanation of meaningful state changes.

## Contract

The contract version is `3B.1`. Every event has a globally unique UUID, registered event and aggregate types, aggregate ID, correlation ID, ISO occurrence time, registered source, compact JSON payload and metadata, payload hash, contract version, and creation time. Causation ID, command ID, actor, and deterministic dedupe key are optional.

`correlation_id` identifies the overall request or workflow chain. `causation_id` identifies the exact command or event that caused the transition. They are intentionally separate. An external command uses its V3A correlation ID; scheduled work uses its run ID. Child enrichment preserves the originating human-action/command correlation when it exists and records the preceding canonical event as its cause.

The aggregate registry is deliberately small: `COMMAND`, `JOB`, `APPLICATION`, `ENRICHMENT`, `COMMUNITY`, `RESEARCH`, `CONTACT`, `SHEET_SYNC`, `NOTIFICATION`, and `OPERATIONAL_RUN`. Event names are registered uppercase past-tense transitions in `workflow-events/contracts.mjs`; arbitrary strings are rejected.

## Persistence and integrity

Migration 025 creates `workflow_events`, query indexes, a partial unique index for dedupe keys, a SHA-256 payload hash, and SQLite triggers that reject every update or delete. Corrections must append a registered correction event. There is no automatic retention.

All writes go through `WorkflowEventWriter`. It validates the contract, adds IDs/times, strips credential and large-document fields, bounds strings/arrays/depth, rejects JSON over 16 KiB, hashes the sanitized payload, and inserts atomically. Domain methods use the writer inside the same SQLite transaction whenever state and history must agree. A deterministic source-transition key makes retryable bridges idempotent without deduplicating independent syncs or runs.

Never put resumes, cover letters, browser HTML, job-description bodies, credentials, tokens, cookies, or raw sensitive human answers in an event. Store stable IDs, reason/status codes, small summaries, hashes, and references. Human answers use an `answerRef`/application fact ID.

## Source bridges

| Subsystem | Strategy | Canonical events |
|---|---|---|
| `workflow_commands` | Native emit | received, started, completed, failed |
| Human actions | Native transactional emit | meaningful job/application/community decisions; no `NO_ACTION` noise |
| Candidate state | Selective native emit | meaningful lifecycle changes only; rank movement excluded |
| `application_enrichment_events` | Native transition bridge | queued, started, completed, blocked, failed |
| Evaluations/packages | Native emit | valid evaluation and package transitions; artifact references only |
| `application_execution_events` | Native transition bridge | started, attempted, needs-human, verification-unknown, confirmed, failed, cancelled |
| `facebook_community_events` | Native transition bridge | discovery and meaningful membership transitions |
| Research needs | Native emit | created once, resolved, blocked |
| Sheet sync runs | Native emit | started, completed, failed; tab names/counts only |
| Notifications | Native emit | sent, failed, disabled/skipped |
| Operational runs | Native emit | started and terminal outcome |
| Browser semantic telemetry | No canonical event | remains detailed subsystem telemetry to prevent event spam |
| Feedback/calibration internals | No canonical event | derived analytics, not workflow transitions |

The activation strategy is forward-only. V3B does not fabricate historical causality or bulk-backfill old subsystem rows. Existing Supabase `NEEDS_HUMAN` / `VERIFICATION_UNKNOWN` state remains unchanged and is not relabeled as applied.

## Timeline API

`WorkflowTimelineService` is the read boundary for callers:

- `getByCorrelation(correlationId)`
- `getForJob(jobId)`
- `getForApplication(applicationIdOrJobId)`
- `getForCommunity(communityId)`
- `getRecent(limit)`

Each result is chronological and normalized to timestamp, event type, lifecycle stage (`DISCOVER`, `DECIDE`, `PREPARE`, `APPLY`, `TRACK_LEARN`, `COMMUNITY`, `SYSTEM`), status, deterministic human summary, source, correlation/causation, and references. UI callers do not parse `payload_json`.

Use the read-only CLI:

```bash
npm run timeline -- correlation <correlation-id>
npm run timeline -- job <job-id>
npm run timeline -- application <application-or-job-id>
npm run timeline -- community <community-id>
npm run timeline -- recent 50
npm run timeline -- job <job-id> --json
```

## Adding an event

1. Confirm the transition is meaningful and not existing low-level telemetry.
2. Add its constant, lifecycle stage, and deterministic summary to the workflow-event modules.
3. Define the smallest useful payload and reference schema; do not include raw sensitive or large content.
4. Emit only through `WorkflowEventWriter`, in the state transaction where practical.
5. Supply correlation, exact causation, and a source-transition dedupe key for retryable operations.
6. Add contract, transition, retry, transaction, and timeline tests. Do not change `3B.1` semantics silently; create a new contract version for incompatible meaning.
