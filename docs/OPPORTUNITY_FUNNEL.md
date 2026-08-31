# Eligibility and Opportunity Ranking Funnel

Career Ops can now answer whether a discovered job is viable and worth deeper evaluation without calling an LLM:

```text
Job Registry observation
        |
        v
Eligibility Engine --------> ELIGIBLE | INELIGIBLE | UNKNOWN
        |
        +--> Candidate Fit -- role alignment only
        |
        +--> Opportunity ---- location, engagement, schedule, compensation, strategic value
        |
        v
Final Priority ------------> SHORTLIST | CONSIDER | REVIEW | REJECT
        |
        v
JobRegistry.recordAssessment()
```

The engines in `intelligence/` are pure, deterministic functions. They do not import SQLite, mutate the Job Registry, call models, or perform network requests. `registry/job-registry.mjs` remains the only persistence writer.

## Canonical policy

`config/profile.yml` is authoritative for candidate location, work authorization, accepted work arrangement, seniority, schedule, employment preference, and compensation floors. Existing `portals.yml` title and country-eligibility vocabularies are read as search-policy extensions instead of being copied into the engine.

The normalized policy receives a deterministic `profileHash`. A change to relevant profile policy therefore makes the same observation eligible for a new assessment without silently replacing the old one. Contact details and unrelated profile fields do not affect this hash.

## Eligibility

`EligibilityResult` contains `status`, `eligibilityScore`, readable `reasons`, field-level `evidence`, `confidence`, `rulesApplied`, and `rulesVersion`.

Hard, explicit conflicts produce `INELIGIBLE`, including configured excluded seniority, required on-site/hybrid attendance, country-locked remote work that excludes Mexico, regular night/frequent on-call requirements, stated commitment below the profile minimum, and directly comparable compensation below the relevant floor.

Worldwide, global, Mexico, LATAM, or international-contractor scope provides affirmative eligibility evidence. A bare `Remote` label remains `UNKNOWN`; missing compensation also remains unknown and is never estimated. Contradictory location evidence is sent to manual review.

## Separate ranking dimensions

- `eligibilityScore` is a status projection: 100 eligible, 50 unknown, 0 ineligible. It is not candidate fit.
- `candidateFit.score` compares the title with configured role phrases only. An otherwise poor opportunity can retain high technical fit.
- `opportunity.score` combines location (25%), engagement model (25%), schedule (20%), compensation (20%), and strategic value (10%).
- `finalPriority.score` combines candidate fit (45%) and opportunity quality (55%), then applies the eligibility gate. `INELIGIBLE` becomes `REJECT`; `UNKNOWN` is capped at `REVIEW`.

Employment preference follows the profile: contract, fractional, part-time, then full-time. Flexible full-time remains viable and receives a higher component score than rigid full-time; it is not automatically rejected.

Compensation is `KNOWN`, `UNKNOWN`, or `LOW_CONFIDENCE`. Comparison occurs only when currency and period match the configured employment-type floor. The engine does not invent missing amounts or convert currencies/periods.

## Versioning and history

Schema migration `003_opportunity_assessments.sql` adds append-only `job_assessments`. Each row retains:

- job and source observation;
- eligibility, candidate-fit, opportunity, and final-priority scores;
- decision, confidence, reasons, evidence, and applied rules;
- eligibility/ranking rule versions;
- relevant profile hash and assessment-input hash;
- calculation and persistence timestamps;
- the complete structured result.

An assessment key includes observation, both rule versions, profile hash, and input hash. Exact repeats are idempotent. A rule/profile/content change creates a historical row.

## Controlled execution

Assessment is not part of `scan.mjs` or the automatic Daily Runner lifecycle in this increment. Inspect candidates first:

```bash
npm run rank -- pending --run <daily-run-id> --limit 100
```

Persist assessments explicitly:

```bash
npm run rank -- assess --run <daily-run-id> --limit 100
npm run rank -- assess --job <job-id>
npm run rank -- show <job-id>
```

With `--run`, candidates are observations seen in that run that lack an assessment for the current observation, profile hash, and rule versions. This naturally selects new jobs, changed observations, and previously unassessed jobs while skipping already assessed unchanged snapshots. Without `--run`, the command is an explicit bounded backfill over unassessed latest observations. The limit defaults to 100 and is capped at 1,000.

The future Daily Runner integration point should pass the completed discovery run ID into this same candidate query. It must remain opt-in until execution policy is explicitly enabled; no historical mass reassessment occurs automatically. A `SHORTLIST` result is the mandatory cost gate for the separate Deep Evaluation flow documented in `docs/DEEP_EVALUATION.md`.

## Deferred scope

This funnel itself makes no LLM call. Deep Evaluation and Application Package Generator are separate, explicit downstream commands. Application submission, recruiter research, contact delivery, scheduler, notification, Google integration, authenticated source, and browser automation remain deferred. Semantic text rules are deliberately versioned because external wording evolves and deterministic signals cannot resolve every ambiguous posting.
