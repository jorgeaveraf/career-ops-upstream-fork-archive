# Workflow Status

V3C adds a read-only display model over the canonical V3B event timeline. SQLite domain tables remain authoritative; `workflow_events` explains how the current state was reached, and `WorkflowStatusService` combines both before anything is shown in Google Sheets.

## Display model

The reusable service is `workflow-status/service.mjs` and exposes:

- `getJobStatus(jobId)`
- `getCommandStatus(commandId)`
- `getCommunityStatus(communityId)`
- `getRecentActive(limit)`

A job result includes its ID, correlation ID, product stage, compact workflow status, latest event and summary, timestamps, attention flag, blocker, and up to five recent events. Correlation and recent-event details remain internal.

## Stages and statuses

Product stages are `DISCOVER`, `DECIDE`, `PREPARE`, `APPLY`, `TRACK_LEARN`, `COMMUNITY`, and `SYSTEM`.

User-facing statuses are `IDLE`, `QUEUED`, `PROCESSING`, `WAITING_FOR_HUMAN`, `READY_FOR_REVIEW`, `COMPLETED`, `FAILED`, and `BLOCKED`.

Representative mappings:

| Canonical event | Stage | Display status |
|---|---|---|
| `JOB_NEXT_STAGE_REQUESTED` | PREPARE | QUEUED |
| `ENRICHMENT_QUEUED` | PREPARE | QUEUED |
| `ENRICHMENT_STARTED` | PREPARE | PROCESSING |
| `ENRICHMENT_COMPLETED` | PREPARE | READY_FOR_REVIEW |
| `ENRICHMENT_BLOCKED` | PREPARE | BLOCKED |
| `APPLICATION_APPROVED` | APPLY | QUEUED |
| `APPLICATION_EXECUTION_STARTED` | APPLY | PROCESSING |
| `APPLICATION_NEEDS_HUMAN` | APPLY | WAITING_FOR_HUMAN |
| `APPLICATION_VERIFICATION_UNKNOWN` | APPLY | WAITING_FOR_HUMAN |
| `APPLICATION_CONFIRMED` | APPLY, then TRACK_LEARN in authoritative state | COMPLETED |
| `APPLICATION_FAILED` | APPLY | FAILED |

Mappings are deterministic. Do not infer an active state merely because an event is absent. Authoritative enrichment and execution rows override stale timeline observations.

## Command status is not job status

A command uses `QUEUED`, `PROCESSING`, `SUCCESS`, or `FAILED`. `Sync Jobs: SUCCESS` means the bounded request was processed successfully. A job may correctly end in `WAITING_FOR_HUMAN`; that is a safe domain outcome, not a command failure.

TODAY shows a compact Last Command area on the first visible row while SETTINGS retains the complete command audit. Apps Script only reports acceptance after HTTP 202 and never claims early completion.

## Sheet projection boundaries

Canonical events are never coalesced. Sheet writes are coalesced at the projection boundary:

- Apps Script writes the immediate accepted/QUEUED audit state.
- A command imports Sheet decisions and performs its bounded domain work without an intermediate projection push.
- After command completion, the worker performs one final projection containing both command outcome and current domain state.
- Direct CLI syncs retain their normal final push.

TODAY displays only Workflow Stage, Workflow Status, Last Activity, Last Updated, Human Blocker, and Recommended Action. Legacy decision/enrichment/execution columns remain in the contract for compatibility but are hidden. Full history remains available through the timeline CLI.

## Adding a mapping

1. Add the canonical event to the V3B contract and stage map.
2. Add its deterministic display status in `workflow-status/service.mjs`.
3. Add an authoritative-state rule when the corresponding domain table can verify current state.
4. Add mapping, domain-override, timezone, and idempotency tests.
5. Keep event text deterministic and free of secrets, raw documents, stack traces, or provider-specific wording.

Real-time means the Sheet updates as soon as Career Ops completes a meaningful workflow boundary and performs its normal write. V3C adds no polling, WebSocket, cache, scheduler, topic, or service.
