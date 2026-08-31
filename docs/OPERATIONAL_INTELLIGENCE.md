# Operational Intelligence (V3E)

Career Ops persists operational signals, observations and recovery attempts in SQLite. The five-minute native watcher scans authoritative local/cloud health, applies only allowlisted bounded recoveries, verifies their outcome, and escalates anything unsafe or exhausted through the existing V3D notification outbox.

Commands:

- `npm run ops -- status --json` — persisted summary.
- `npm run ops -- scan --json` — scan and bounded recovery.
- `npm run ops -- signals --json` — unresolved signals.
- `npm run ops -- recoveries --json` — verified recovery history.
- `npm run ops -- recover <signal-id> --json` — policy-checked manual recovery; unsafe signals return `POLICY_BLOCKED`.
- `npm run operational:launch-agent -- install|load|status` — manage the native watcher.
- `npm run pipeline:diagnostics -- --trace` — read-only V4.7 strong-admission trace from the Registry.
- `npm run today:diagnostics -- --trace` — read-only V4.7 top-Pipeline and Human-carryover trace.

Safe recovery is limited to canonical LaunchAgent restart, verified stale-lock removal, idempotent command resumption, expired enrichment lease requeue, orphaned internal-run closure, projection-only Sheet retry, pending notification drain, and temporary per-run source degradation.

Never automatic: application resubmission, ambiguous email resend, social messaging, challenge bypass, human answers, policy/ranking changes, DNS, IAM, key rotation, account creation, or browser-profile changes.

Runbooks:

1. `APPLICATION_VERIFICATION_UNKNOWN`: inspect the ATS or Jorge mailbox manually; never submit again until external state is known.
2. `WORKSPACE_AUTH_FAILED`: generate and verify a fresh broker/DWD token; never fall back to user ADC or another identity.
3. `GATEWAY_UNHEALTHY`: inspect Cloud Run and logs; V3E does not deploy or roll back cloud infrastructure.
4. `OPERATIONAL_WATCH_FAILURE`: inspect `logs/operational-watch/` and `launchctl print gui/$UID/com.careerops.operational-watch`.
5. Repeated/flapping failures: automatic attempts stop after two; the signal remains escalated with immutable event history.
6. `PIPELINE_ADMISSIBLE_NOT_PROJECTED`, `PIPELINE_RANK_INVARIANT_FAILED`, `PIPELINE_DUPLICATE_ACTIVE`, `PIPELINE_TERMINAL_PRESENT`, `PIPELINE_POLICY_CONTRADICTION`, or the corresponding TODAY invariant: inspect canonical state and run bounded reconciliation; never fill a slot from weak Registry entries. A legitimately small Pipeline and its resulting TODAY underfill emit no signal and remain healthy.
