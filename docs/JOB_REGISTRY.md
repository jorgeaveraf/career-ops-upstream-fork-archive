# Job Registry

Career Ops keeps acquisition memory in SQLite while preserving the existing Markdown/TSV workflows.

```text
daily runner -> scan.mjs -> acquisition buffer -> JobRegistry (SQLite)
                         |
                         +-> existing filters -> pipeline.md / scan-history.tsv
```

`data/career.db` is the operational source of truth for runs, canonical jobs, and observations. `data/pipeline.md` and `data/applications.md` remain human-readable compatibility views and are not removed or rewritten by the registry. The blanket `data/*` rule in `.gitignore` keeps the database, WAL, and shared-memory files out of Git.

## Boundaries

- `acquisition/contracts.mjs` defines provenance/evidence, semantic acquisition errors, `JobSearchProvider`, and `PageReader`; see `docs/ACQUISITION.md`.
- `acquisition/content-validation.mjs` makes `HTTP_SUCCESS != CONTENT_SUCCESS` explicit. Direct and optional Jina readers use the same classification.
- `registry/job-registry.mjs` is the only SQLite write boundary. Providers receive HTTP context and return `Job[]`; they never receive a database connection.
- `scan.mjs` buffers sufficiently identified provider results and records the batch in one transaction before writing Markdown/TSV. `--dry-run` creates no run or database state.
- `runner/daily-runner.mjs` owns daily lifecycle, recovery, and summary construction while reusing `scan.mjs`; see `docs/DAILY_RUNNER.md`.
- `job-registry.mjs` provides local inspection and an explicit bootstrap. It never modifies Markdown.

## Schema version 11

Migrations: `registry/migrations/001_operational_registry.sql` through `011_browser_discovery_strategy.sql`. Applied migrations are recorded in `schema_migrations`, and SQLite `user_version` is set to the same version. A database newer than the code is rejected.

### Tables

| Table | Purpose |
|---|---|
| `schema_migrations` | Ordered migration ledger |
| `runs` | Scan/bootstrap lifecycle, metadata, and reproducible counters |
| `jobs` | Canonical display values plus deterministic normalized keys, first/last seen, and minimal status (`DISCOVERED`) |
| `job_observations` | Immutable content snapshots plus first/last occurrence, provider provenance, identity decision, and content-change flag |
| `job_identities` | Strong aliases: provider/external ID, canonical URL, and source URL |
| `job_field_evidence` | Field-level value, confidence, extraction method, provider, and source URL |
| `run_observations` | Many-to-many run attribution; lets an exact snapshot be seen again without duplicating it |
| `run_failures` | Typed provider/target failures for later runner summaries |
| `run_provider_results` | Per-run, per-provider/target success/failure and observation counts |
| `job_assessments` | Append-only, versioned eligibility and ranking results tied to the exact source observation |
| `job_evaluations` | Append-only deep evaluations, including rejected model attempts, tied to the shortlist assessment and exact evidence/version identity |
| `application_packages` | Versioned resume/cover/outreach/note drafts and rejected attempts, tied to one valid APPLY evaluation and explicit human-review state |
| `companies`, `company_evidence`, `job_companies` | Canonical company identity, append-only source evidence, and job linkage |
| `people`, `person_evidence` | Canonical people per company with append-only source evidence and explicit confirmed/unknown state |
| `contact_research`, `contact_research_people`, `contact_relationships` | Versioned Contact Intelligence artifacts, observed people, conservative relationship classification, and human-review state |
| `sheet_sync_state`, `sheet_sync_runs` | Current and append-only Google Sheets projection sync state |
| `human_actions`, `human_field_state` | Audited accepted/rejected sheet inputs and their current materialized human-owned values |
| `operational_runs`, `notification_deliveries` | Daily end-to-end run summaries and idempotent notification outcomes |
| `browser_research_observations`, `browser_research_run_observations` | Deduplicated research evidence and per-run attribution |
| `browser_discovery_metrics` | Per-run/provider discovery, validation, duplicate, downstream-quality, and ROI inputs |
| `browser_discovery_task_results`, `browser_discovery_task_observations` | Per-run/source/strategy/query results, explanations, durations, rejection counts, and exact observation attribution for strategy metrics |

Foreign keys are enabled. Important indices cover job last-seen time, normalized company/title, observation job/time, provider/external ID, content hash, identities, run outcomes, and failures.

SQLite uses WAL for file-backed databases, `synchronous=NORMAL`, a 5-second busy timeout, foreign keys, and transactions. This supports several provider tasks producing results in parallel while serializing the one persistence batch; it is not intended as a distributed database.

`intelligence/` engines return data and never receive a database handle. The explicit opportunity-funnel command calls `JobRegistry.recordAssessment()`, preserving the registry as the only writer. Exact reassessment under the same observation, rules, profile, and input is idempotent; changed rule versions or policy hashes append history. See `docs/OPPORTUNITY_FUNNEL.md`.

`deep-evaluation/` likewise has no database access. Its artifact is persisted only through `JobRegistry.recordJobEvaluation()`. Evaluations remain separate from opportunity assessments and preserve CKB, engine, prompt, provider/model, and job-analysis versions. See `docs/DEEP_EVALUATION.md`.

`application-package/` consumes a valid APPLY evaluation, current CKB, and the canonical CV without writing any of them. Only `JobRegistry.recordApplicationPackage()` persists its structured artifact. `updateApplicationPackageStatus()` records human review but has no external side effect. See `docs/APPLICATION_PACKAGE.md`.

`contact-intelligence/` consumes a ready Application Package and evidence-bearing public research observations without database access. Only `JobRegistry.recordContactResearch()` consolidates company/person identity and appends evidence and research versions. See `docs/CONTACT_INTELLIGENCE.md`.

`human-control-plane/` projects registry facts to Google Sheets and imports only explicitly human-owned fields. The spreadsheet is never a replacement source of truth, and rejected Career Ops-field edits are audited without changing registry facts. See `docs/HUMAN_CONTROL_PLANE.md`.

`automation/` creates a separate operational run around the existing Daily Runner and downstream explicit boundaries. It persists the reproducible summary and one notification outcome per channel without changing the discovery lifecycle. See `docs/DAILY_AUTOMATION.md`.

## Lifecycle

1. `createRun()` creates a `PENDING` run; `startRun()` transitions it to `RUNNING`. A direct legacy scanner call performs both steps.
2. Providers acquire jobs without persistence access.
3. The scanner buffers every usable observation before eligibility/user filters.
4. `recordObservations()` resolves identity and persists the entire batch transactionally.
5. Existing scanner filters and Markdown/TSV writes continue unchanged.
6. Provider failures are attached to the run.
7. `finishRun()` derives observations/new/known/changed/duplicate/failure counters from database facts and records `SUCCESS`, `PARTIAL`, or `FAILED`.

An abandoned `RUNNING` run becomes `INTERRUPTED` during Daily Runner recovery. Terminal runs are never resumed.

If registry persistence fails, its transaction rolls back and the scanner does not continue to Markdown writes. A later fatal scanner error marks the active run failed on a best-effort basis.

## Deterministic identity and deduplication

Automatic identity resolution is deliberately conservative, in this order:

1. exact normalized `provider + external_id`;
2. exact canonical URL;
3. exact normalized source URL;
4. otherwise create a new canonical job.

An exact company/title/location/content-hash match is recorded as an ambiguous candidate, but is **not** auto-merged. This prevents two requisitions, reposts, sibling locations, or reopened roles from collapsing merely because they share text. Cross-provider merging therefore requires a shared canonical/source ATS URL in this increment.

Every observation stores `identity_method`, `identity_confidence`, and `identity_evidence_json`, making a join explainable. New identity aliases point back to the observation that supplied them.

### Canonicalization

- **URLs:** require HTTP(S), lowercase host/path, remove fragments/trailing slash, remove only allowlisted locale/tracking parameters, sort remaining query parameters, and preserve identity-bearing parameters such as `gh_jid`.
- **Provider IDs:** NFKC, trim, lowercase. Scanner provenance currently uses IDs such as `greenhouse-api`.
- **Titles:** NFKC, lowercase, retain Unicode letters/marks/numbers, fold punctuation/whitespace. No seniority/team/location semantics are discarded.
- **Companies:** existing Career Ops `normalizeCompanyName()` normalization.
- **Locations:** NFKC/lowercase with Unicode-safe punctuation and whitespace folding.
- **Content:** SHA-256 of the normalized description text. The older 64-bit SimHash in `scan-history.tsv` remains a cross-listing signal and is imported only as legacy metadata, not mislabelled as a content hash.

An observation key is a SHA-256 over provider, strongest available source identity, and deterministic snapshot hash. Seeing the exact snapshot again updates `last_observed_at`/`seen_count` and adds a `run_observations` attribution; it does not create another snapshot. A different description under the same provider/external ID creates a new observation on the same job with `content_changed=1`.

## Run summaries

`finishRun()` persists counters so the Daily Runner can report without parsing terminal logs:

```json
{
  "observations": 6397,
  "newJobs": 7,
  "knownJobs": 6390,
  "changedJobs": 3,
  "duplicateObservations": 6387,
  "failures": 2
}
```

Counts represent unique snapshots attributed to the run. Exact repeated input within one run is idempotent because `(run_id, observation_id)` is unique.

## Explicit bootstrap

Bootstrap is not automatic and never changes existing files:

```bash
node job-registry.mjs bootstrap
# alternate local DB or fixture files
node job-registry.mjs bootstrap --db /tmp/career.db --history fixture.tsv --pipeline fixture.md
```

The bootstrap imports:

- `data/scan-history.tsv`: URL, first-seen date, provider, title, company, status, location, posted date, legacy fingerprint and trust metadata;
- `data/pipeline.md`: URL, company, title, best-effort location, pending/processed marker, and original line. Explicit `EVALUADA`/`EVALUATED`, `DESCARTADA`/`DISCARDED`, or `SKIP` note markers are imported as job status; absent or ambiguous wording remains `DISCOVERED`.

It does **not** import `data/applications.md` in version 1. Tracker rows usually point to reports rather than the original job URL, and some use agency/end-employer distinctions; inventing a job identity would be unsafe. Existing applications remain available to the current tracker workflow and can be linked in a later explicit migration with stronger evidence.

The bootstrap run ID is derived from its parser-format version plus a SHA-256 of both input files. Repeating the same bootstrap returns the completed run and writes nothing. Changed sources or a future parser revision create a new bootstrap run while observation keys prevent duplicate snapshots.

## Inspecting local state

```bash
npm run registry -- schema
npm run registry -- jobs
npm run registry -- summary <run-id>
```

Direct read-only inspection with the system SQLite CLI is also possible:

```bash
sqlite3 'file:data/career.db?immutable=1' '.tables'
sqlite3 'file:data/career.db?immutable=1' 'SELECT id,status,observations_count,new_jobs_count FROM runs ORDER BY started_at DESC LIMIT 10;'
```

Override the runtime location with `CAREER_OPS_DB=/path/to/career.db`. The default is `data/career.db`.

## Tests

Normal tests are offline and use in-memory or temporary SQLite databases:

```bash
node --test tests/job-registry.test.mjs tests/job-registry-bootstrap.test.mjs tests/acquisition-foundation.test.mjs
node test-all.mjs --quick
```

Coverage includes new jobs, exact duplicates, cross-provider canonical URLs, changed descriptions, similar/distinct requisitions, ambiguous no-ID sources, restart persistence, rollback on transaction failure, run attribution, deterministic canonicalization, migrations/pragmas, versioned assessments, content validation, and idempotent bootstrap.

## Privacy and deferred scope

The registry stores opportunity data, deterministic assessments, structured deep-evaluation artifacts, application-package drafts, browser-research evidence, and operational metadata only. Browser evidence is append-attributed through `browser_research_observations` and `browser_research_run_observations`; validated `JOB` observations also enter the normal Registry Boundary. It stores the CV hash, not a second canonical CV or full CKB snapshot. It must not store credentials, cookies, tokens, Google data, or browser sessions. Browser Research stores URLs, extracted evidence, confidence, and provenance only; applications, messages, forms, and social actions remain outside its scope.
