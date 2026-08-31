# Bounded Candidate Selection

Increment 11A introduces a deterministic boundary between the raw Job Registry and expensive opportunity processing.

```text
Core providers ─┐
                ├─> Job Registry (raw, append-only observations)
Browser research┘
                         │
                         v
              CandidateSelectionEngine
              cheap rules + policy v2
                         │
              ┌──────────┴──────────┐
              v                     v
       filter decisions       rolling active set
                                    │
                                    v
                     eligibility + opportunity ranking
                                    │
                                    v
                         daily priority snapshot
                                    │
                                    v
                            bounded TOP 10
```

The Registry remains the source of truth. Candidate selection never deletes or rewrites raw jobs or observations, does not call an LLM, and does not access providers or browsers.

## Pure boundary

`CandidateSelectionEngine` receives plain candidate records, the previous active set, a versioned policy, and a clock. It returns filter decisions, selected candidates, lifecycle transitions, and reconcilable counts. It has no database dependency.

Rules are high-recall but explicit. They cover target-title/domain matching, excluded seniority, blocked companies, talent-pool signals, explicit remote/location and country restrictions, posting freshness, minimum evidence, human decisions, and application state. Text normalization uses NFKD accent folding. Short location aliases such as `US`, `EU`, and `UK` match complete tokens.

The preliminary candidate-selection score is intentionally separate from eligibility, candidate fit, opportunity quality, and final priority. Capacity is a ceiling, never a target.

## Policy v2

The policy is derived from `config/profile.yml` and `portals.yml` and persisted with `rulesVersion` and `policyHash`.

- Maximum active candidates: 100.
- Selection threshold: 58.
- Freshness window: 21 days, inherited from `portals.yml`.
- Fill to capacity: false.
- TOP limit: 10.
- TOP minimum final-priority score: 80.
- Provider diversity: at most 50 candidates for one canonical source when multiple sources qualify.
- Provider aliases such as `greenhouse` and `greenhouse-api` share one selection identity.

Source diversity only limits a dominant source; it never promotes a candidate below the quality threshold. Talent-pool observations are penalized and marked, and pool-only rows cannot enter TOP 10.

## Lifecycle and persistence

Migration `012_bounded_candidate_set.sql` adds:

- `candidate_selection_runs`: policy and aggregate selection result per run.
- `candidate_filter_decisions`: one PASS/REJECT/UNKNOWN decision per run and job, with reasons and evidence references.
- `active_candidates`: current rolling state and rank metadata.
- `active_candidate_transitions`: idempotent longitudinal state transitions.
- `daily_priority_snapshots`: ranked, immutable-by-run daily projection and TOP marker.
- `semantic_funnel_metrics`: run-scoped stage counts.

Candidate states are `ACTIVE`, `CARRYOVER`, `EXPIRED`, `DISCARDED`, `ACTED`, and `SUPERSEDED`. A still-qualified prior candidate becomes `CARRYOVER` when it has no new observation. Human `REJECT`, applied/interview/offer/rejected/hired states, and archived state are terminal and cannot re-enter the active set without a later explicit state change.

Repeated processing of the same run updates the same decisions, snapshot, and metrics; it does not create duplicate observations, assessments, or transitions.

## Daily snapshot and TOP 10

Every ranking run stores job and observation identity, current and previous rank, movement, final score, eligibility, candidate fit, opportunity quality, reasons, confidence, pool marker, and weak-evidence marker.

TOP 10 is a maximum. A row must be `ELIGIBLE`, have a `SHORTLIST` decision, meet final-priority score 80, and not be pool-only. Missing descriptions remain visible as `evidenceWeak=true`; the engine does not pretend that title/location-only evidence is complete.

## Metrics semantics

The `candidate_selection` scope uses the latest observation of every canonical Registry job as its run input. Therefore:

```text
RAW_DISCOVERED = NORMALIZED = UNIQUE_JOBS
FILTER_PASS + FILTER_REJECT + FILTER_UNKNOWN = UNIQUE_JOBS
ELIGIBILITY_ELIGIBLE + ELIGIBILITY_INELIGIBLE + ELIGIBILITY_UNKNOWN = RANKED
TOP_10 <= 10
ACTIVE_SET <= 100
```

These are run-scoped operational metrics. Existing acquisition/run counters and lifetime Registry totals remain separate.

## Control plane boundary

`JobRegistry.getOperationalCandidateData()` exposes the active set, latest snapshot, TOP 10, and metrics. `getControlPlaneData()` accepts `candidateScope: all | active | attention`; its default remains `all` to avoid the visual/tab redesign reserved for Increment 11C.

## Commands

```bash
npm run candidate-set -- status --json
npm run candidate-set -- bootstrap --dry-run --json
npm run candidate-set -- bootstrap --json
```

The persistent bootstrap creates a SQLite backup first, uses a deterministic date/version/policy run ID, and is safe to repeat. It performs no scan and no browser navigation.

