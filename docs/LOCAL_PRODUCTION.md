# Local Production Operations on macOS

Career Ops remains entirely on the current Mac:

```text
macOS LaunchAgent
  -> startup validation
  -> safe SQLite backup
  -> daily:auto
  -> local logs + SQLite state
  -> Google Sheets + optional email
```

No repository, database, secret, browser profile, or execution is moved to another machine. No cloud deployment or Docker is introduced. Separate Browser Research may read through the existing local Jorge Chrome profile under `docs/BROWSER_RESEARCH_POLICY.md`.

## Health check

```bash
npm run health
npm run health -- --json
npm run health -- --json --no-log
```

The health check verifies Node, SQLite existence and `quick_check`, schema version, latest operational run, latest Sheet push, latest notification, pending human actions, free disk, required files, `.env` permissions, renewable OAuth, read-only Sheet access, Browser Research policy, the Jorge Chrome profile, and lock availability. It does not scan, sync, email, migrate the database, or navigate. Exit `0` means no blocking failure; exit `1` means unhealthy.

`daily:auto` uses the same configuration validator before any backup, discovery, sync, or email stage, then performs one authenticated, read-only Google Sheets metadata request. A missing database, Sheet ID, renewable OAuth credential, required project file, enabled-email credential, failed refresh, or lost Sheet access fails closed and is written to `logs/errors/`.

## Local logs

Runtime logs are gitignored and split into:

```text
logs/daily/YYYY-MM-DD.jsonl
logs/errors/YYYY-MM-DD.jsonl
logs/health/YYYY-MM-DD.jsonl
logs/browser/YYYY-MM-DD.jsonl
logs/browser/discovery/YYYY-MM-DD.jsonl
logs/daily/launchd.stdout.log
logs/errors/launchd.stderr.log
logs/browser/launchd.stdout.log
logs/browser/launchd.stderr.log
```

Directories use private permissions and JSONL records contain timestamp, event, result, duration/summary, or diagnostic. Launchd captures process stdout/stderr separately. No external logging service is used. Log rotation is manual in this increment.

## SQLite backup

Every non-dry `daily:auto` run creates a SQLite-native snapshot before discovery. Disable only when explicitly necessary with `CAREER_OPS_BACKUP_ENABLED=false`.

```bash
npm run backup -- create
npm run backup -- create -- --out /private/local/path --keep 30
npm run backup -- validate backups/sqlite/career-....db
```

Defaults:

- source: `data/career.db`;
- destination: `backups/sqlite/`;
- retention: newest 30 snapshots;
- file permissions: `0600`;
- validation: SQLite `quick_check`, schema version, and required operational tables.

Override with `CAREER_OPS_BACKUP_DIR` and `CAREER_OPS_BACKUP_KEEP`. Backups never leave the Mac.

### Restore procedure

Restoration is deliberately manual because it replaces the source of truth:

1. Unload the LaunchAgent and confirm no Daily Runner lock is active.
2. Run `npm run backup -- validate <backup.db>`.
3. Create one final backup of the current database.
4. Move `data/career.db`, `data/career.db-wal`, and `data/career.db-shm`—when present—to a timestamped local quarantine directory.
5. Copy the validated snapshot to `data/career.db` and set mode `0600`.
6. Run `npm run health -- --no-log` before loading the LaunchAgent again.

Do not overwrite a live SQLite database or restore only its WAL/SHM files.

## LaunchAgent

Generate or install the per-user agent:

```bash
# inspect without installing
npm run launch-agent -- generate --hour 16 --minute 0

# write ~/Library/LaunchAgents/com.careerops.daily.plist idempotently
npm run launch-agent -- install --hour 16 --minute 0

# explicit lifecycle
npm run launch-agent -- load
npm run launch-agent -- status
npm run launch-agent -- unload
```

Installation writes one fixed label/path with mode `0600`; running it twice does not create another agent. `load` and `unload` use the current user's `launchctl` GUI domain. Installation does not load the agent automatically.

The plist runs `npm run daily:auto -- --scheduled --json`, uses the repository as `WorkingDirectory`, captures logs, sets `RunAtLoad`, and schedules 16:00. `daily:auto --scheduled` skips before the configured time and skips if any operational run already started that local day. The existing Daily Runner lock still prevents concurrent execution. Browser Research runs first at 15:30 so the core pass produces one same-day converged candidate snapshot, Sheet projection, and notification decision.

Configuration:

```dotenv
CAREER_OPS_TIMEZONE=America/Mexico_City
CAREER_OPS_SCHEDULE_HOUR=16
CAREER_OPS_SCHEDULE_MINUTE=0
BROWSER_RESEARCH_SCHEDULE_HOUR=15
BROWSER_RESEARCH_SCHEDULE_MINUTE=30
CAREER_OPS_LOG_DIR=logs
CAREER_OPS_BACKUP_ENABLED=true
CAREER_OPS_BACKUP_DIR=backups/sqlite
CAREER_OPS_BACKUP_KEEP=30
CAREER_OPS_MIN_FREE_DISK_MB=1024
```

Launchd evaluates `StartCalendarInterval` in the Mac's system timezone, so keep macOS set to `America/Mexico_City`; `CAREER_OPS_TIMEZONE` controls the duplicate/day guard. Apple documents that calendar events missed during sleep are coalesced and run after wake. If the Mac was fully powered off, the per-user agent cannot run until login; `RunAtLoad` plus the before-time guard runs it after a late login or waits for 16:00 after an early login. See Apple's [launchd job guide](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html) and the [`launchd.plist` calendar semantics](https://keith.github.io/xcode-man-pages/launchd.plist.5.html).

Manual execution remains:

```bash
npm run daily:auto
```

## Secrets

Secrets live only in the gitignored project `.env` or another secure launchd environment source. For the project-local setup:

```bash
chmod 600 .env
npm run health -- --no-log
```

Required automation values are documented in `.env.example`. Never put credentials in the plist, repository files, shell history, logs, or generated reports. Google Sheets uses renewable OAuth and keeps access tokens in memory; see `GOOGLE_SHEETS_AUTH.md`. To rotate a secret: unload the agent, replace only the affected configuration, keep `.env` mode `0600`, run health, run a dry-run, then load the agent. Resend keys should be revoked at the provider after replacement.

## Browser Research LaunchAgent

The second agent is independent and scheduled at 15:30, before the 16:00 core finalization:

```bash
npm run browser:launch-agent -- generate
npm run browser:launch-agent -- install
npm run browser:launch-agent -- load
npm run browser:launch-agent -- status
npm run browser:launch-agent -- unload
```

It uses label `com.careerops.browser-research`, runs `npm run browser:research -- --scheduled --json`, and writes launchd output under `logs/browser/`. Install does not load it. Required profile, mode, path, lock behavior, evidence contract, and limitations are in `docs/BROWSER_RESEARCH_POLICY.md`.

## Installation status

This increment prepares both LaunchAgents and operational commands but does not install/load either agent or run production Browser Research. Observe the local setup for a real period before deciding whether a dedicated worker machine is justified.
