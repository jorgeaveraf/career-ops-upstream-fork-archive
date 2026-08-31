# Daily Runner

The Daily Runner is the local operational orchestrator above the existing discovery engine:

```text
daily-runner.mjs -> lock + run lifecycle -> scan.mjs -> JobRegistry -> structured summary
```

`scan.mjs` remains the scanner. It resolves configured providers, fetches postings, applies the existing filters, and maintains the Markdown/TSV compatibility files. The Daily Runner does not duplicate that logic: it owns one daily run, invokes the scanner in managed mode, classifies the outcome, and releases the lock.

No scheduler, cron entry, notification, application action, or external integration is installed by this command. The separate `npm run daily:auto` entrypoint composes it into the full operational loop; see `docs/DAILY_AUTOMATION.md`.

## Commands

```bash
npm run daily
npm run daily -- --json
npm run daily -- --dry-run
```

`--json` emits the operational result as JSON. The default output is a human-readable rendering of the same structure.

The orchestrator dry run is intentionally shallower than `scan.mjs --dry-run`: it prints the orchestration plan but does not acquire a lock, open/create SQLite, execute the scanner/providers, or modify Markdown/TSV files.

## Lifecycle

Daily runs use this small state model:

```text
PENDING -> RUNNING -> SUCCESS
                   -> PARTIAL
                   -> FAILED
                   -> INTERRUPTED (recovery of an abandoned run)
```

- `PENDING`: the run record exists but discovery has not started.
- `RUNNING`: the runner owns the local lock and discovery may be active.
- `SUCCESS`: orchestration completed and every recorded provider target succeeded.
- `PARTIAL`: discovery completed, but at least one provider/target or other recoverable acquisition step failed.
- `FAILED`: orchestration or persistence could not complete safely.
- `INTERRUPTED`: a later runner found an abandoned `RUNNING` run. It is terminal; the replacement run starts from the beginning rather than resuming individual providers.

The registry stores creation/start/end/heartbeat timestamps, owner PID, derived duration and observation counters. `run_provider_results` records provider/target outcomes; `run_failures` records typed diagnostics.

## Locking and recovery

The default lock is `data/daily-run.lock`. It is created atomically and contains a random ownership token, run ID, PID, acquisition time, and heartbeat time. A second runner cannot start while the owner PID is alive and the heartbeat is current.

The default stale threshold is six hours. A lock is recoverable when its owner process is gone, its heartbeat has expired, or the file is invalid. After acquiring/recovering the lock, the runner asks `JobRegistry` to mark abandoned `RUNNING` runs as `INTERRUPTED`, then starts a new run. The lock is released only when its token still matches, so one runner does not remove another owner's lock.

Environment overrides:

- `CAREER_OPS_DB`: SQLite path; default `data/career.db`.
- `CAREER_OPS_DAILY_LOCK`: lock path; default `data/daily-run.lock`.

`CAREER_OPS_RUN_ID`, `CAREER_OPS_RUN_TYPE`, and `CAREER_OPS_MANAGED_RUN` are internal runner-to-scanner coordination variables, not normal user options.

## Failure semantics and exit codes

- Provider failure: one target fetch fails while the scanner continues. The run is `PARTIAL`.
- Orchestration failure: the scanner cannot start or exits abnormally. The run is `FAILED` with `ORCHESTRATION_FAILURE`.
- Persistence failure: registry writes/finalization cannot complete safely. The run is `FAILED` with `PERSISTENCE_FAILURE` when SQLite remains writable enough to record it.

Exit codes are stable for future automation:

| Exit | Meaning |
|---:|---|
| `0` | `SUCCESS` (including orchestrator dry-run preview) |
| `1` | `FAILED`, invalid invocation, or active lock |
| `2` | `PARTIAL` |

## Structured summary

The result contains:

```json
{
  "status": "PARTIAL",
  "exitCode": 2,
  "summary": {
    "run": { "id": "...", "type": "daily", "status": "PARTIAL", "durationMs": 4200 },
    "discovery": { "observations": 12, "newJobs": 2, "changedJobs": 1, "knownJobs": 10, "duplicateObservations": 9 },
    "providers": [{ "provider": "greenhouse", "status": "SUCCESS", "targets": 3, "observations": 12, "failures": 0 }],
    "failures": [],
    "recovery": { "interruptedRunIds": [] }
  }
}
```

Provider aggregates and recovered IDs are sorted, and registry failures retain insertion order, so the same persisted facts yield the same summary.

## Troubleshooting

- `DAILY_RUN_LOCKED`: another live runner owns the lock. Inspect `data/daily-run.lock`; do not delete a current lock. A dead/expired owner is recovered automatically on the next run.
- `FAILED` with `ORCHESTRATION_FAILURE`: inspect the failure message and run `npm run doctor`; the scanner may have rejected configuration before provider execution.
- `FAILED` with `PERSISTENCE_FAILURE`: verify that the database directory is writable and that no unrelated process holds SQLite longer than its five-second busy timeout.
- An old run shows `INTERRUPTED`: this is expected crash recovery. The new run is a clean restart, not a provider-level resume.

Known limits: locking is for one local machine, not distributed hosts; recovery is run-level only; no cron or granular provider resume is implemented by this base runner.

## Opportunity funnel integration point

Eligibility and ranking are deliberately not automatic in this increment. After a completed run, `npm run rank -- pending --run <run-id>` uses the registry attribution to select only the latest observations seen by that run which lack an assessment for the current profile and rule versions. This covers new, changed, and previously unassessed jobs without mass-ranking history. A future opt-in Daily Runner stage can call the same boundary after discovery; see `docs/OPPORTUNITY_FUNNEL.md`.
