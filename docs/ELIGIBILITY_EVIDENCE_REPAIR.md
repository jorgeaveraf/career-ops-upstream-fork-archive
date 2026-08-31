# Eligibility Evidence Repair

Increment 11B introduces one provider-independent interpretation of candidate policy:

```text
Active Candidate
  -> Unified Candidate Policy
  -> Evidence Resolver
  -> Eligibility Engine
  -> Typed Research Needs
  -> Candidate Research Queue
```

The provider contributes provenance and confidence only. It cannot change the candidate's remote, geography, employment, schedule, company, pool, or compensation policy.

## Evidence model

The resolver normalizes Unicode deterministically and evaluates `title`, `location`, `description`, explicit eligibility fields, remote scope, eligible-country metadata, hiring-policy metadata, structured compensation, and acquisition metadata. Each evidence record names its field, signal, source, confidence, and effect.

Completeness remains dimensional: description, geography, employment, compensation, schedule, company market, and posting nature. `evidenceWeak` is retained only as a derived compatibility projection.

`Remote` alone is ambiguous. Mexico aliases, LATAM, worldwide, anywhere, and other configured international scopes are positive. An explicit foreign residency lock is negative. Positive and negative geographic evidence together produce `UNKNOWN` plus `RESOLVE_LOCATION_CONFLICT`.

Unknown compensation, schedule, employment model, or company market does not erase proven geographic eligibility. Directly comparable compensation below the evidenced market threshold is a hard stop. No FX, tax, gross/net, period, or jurisdiction conversion is inferred.

Confirmed pool-only observations are rejected. A concrete role containing marketplace language receives a warning and penalty plus `CONFIRM_POSTING_IS_REAL`.

## Research queue

Schema 13 adds `candidate_research_needs` and `candidate_reassessment_queue`. Needs retain observation identity, deterministic priority, lifecycle status, resolution evidence, and all relevant policy/rule versions. Resolving a need creates a single `PENDING` reassessment trigger for that candidate; it does not scan the Registry.

The queue is planning infrastructure only. Increment 11B does not navigate, enrich, message, apply, change Sheets, or execute discovery.

## Controlled command

```bash
npm run eligibility:repair -- --dry-run --json
npm run eligibility:repair -- --json
```

The command reads only the current bounded Active Candidate Set. The persistent form creates a verified SQLite backup first, reassesses only that set, persists needs, and rebuilds its daily priority snapshot.

Versions introduced by this increment:

- unified candidate policy `1.1`;
- eligibility rules `2`;
- evidence completeness `1`;
- research needs `1`;
- ranking rules `3`;
- Registry schema `13`.
