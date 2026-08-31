# Execution Orchestration

Career Ops treats a human Sheet edit as the beginning of a durable workflow, not as the end of a sync operation.

## Canonical reconciliation path

`reconcileSheetHumanInputs` is the single import boundary for both manual **Sync Jobs** and the scheduled daily cycle. It pulls unsynced human cells, records answers and exact application/outreach authorizations, materializes durable work, and asks `WorkerOrchestrator` to wake every relevant worker. The scheduled loop invokes this path before discovery, ranking, evaluation, packaging, or projection. Its final push preserves edits made while the cycle was running.

## Worker registry

| Work type | Worker | LaunchAgent | Durable source |
| --- | --- | --- | --- |
| `ENRICHMENT` | `application-enrichment` | `com.careerops.application-enrichment` | pending enrichment request |
| `APPLICATION` | `application-executor` | `com.careerops.application-executor` | exact `APPROVED_TO_APPLY` authorization |
| `OUTREACH` | `outreach-executor` | `com.careerops.outreach-executor` | exact, due `APPROVED_OUTREACH` authorization |

`worker_work_items` stores `queued_at`, `wake_requested_at`, `claimed_at`, terminal state, attempts and a stable work key. `worker_wake_attempts` stores one of `WAKE_STARTED`, `ALREADY_RUNNING`, `NO_WORK`, `FAILED_RECOVERABLE`, or `FAILED_PERSISTENT` with queue and process evidence. Wake uses `launchctl kickstart` without `-k`; a healthy running worker is never force-restarted.

Application and outreach workers are one-shot drains with a 60-second LaunchAgent fallback. Immediate wake remains the primary path. SQLite uniqueness and existing execution idempotency keys prevent duplicate external mutations.

## Claim SLA and recovery

A queued item should become `WORKING` within 10 seconds. Operational Intelligence detects an older queue as `WORKER_QUEUE_STALE`, performs one allowlisted wake, verifies the result, and escalates only after bounded recovery fails. Normal queueing, active work, and successful recovery are silent.

## Human boundaries

`EXECUTOR_UNAVAILABLE`, worker crashes, transport initialization errors and queue failures are internal operational blockers. They never become `ANSWER_REQUIRED` and never ask for a password, MFA code, token, cookie, or secret.

A real question uses the structured contract `question_id`, `question_type`, `field_key`, `prompt`, `help_text`, `answer_type`, `allowed_values`, `sensitive`, `source_context`, and `blocking_work_id`. The contract rejects credential-like prompts. A supported external/manual route instead becomes `EXTERNAL_ACTION_REQUIRED` with its exact URL and instruction; it is not disguised as a human-answer question.

Application confirmation is still required before after-application outreach. Ambiguous submit or delivery outcomes are never retried automatically.

## Operations

Install or refresh the execution workers:

```bash
npm run execution-workers:launch-agent -- install
```

Inspect them with `npm run execution-workers:launch-agent -- status`. `npm run health -- --json` reports Enrichment Worker, Application Executor, Outreach Executor, and Operational Watcher separately, including queue depth where applicable.
