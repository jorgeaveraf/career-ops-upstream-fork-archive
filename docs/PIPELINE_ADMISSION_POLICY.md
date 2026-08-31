# Pipeline Admission Policy — V4.7

`intelligence/pipeline-admission.mjs` is the canonical, versioned normal-admission policy. It is derived at projection time from the authoritative Registry and related evaluation/lifecycle records; no persistence migration is required.

## Required gates

An admitted opportunity must satisfy every gate:

| Gate | Requirement |
|---|---|
| Active identity | One active canonical Job ID |
| Lifecycle | Not terminal and not Human-rejected |
| Eligibility | `ELIGIBLE` |
| Evidence | Description at least 300 characters and confidence `MEDIUM` or higher |
| Evaluation | Current, complete, and `VALID` |
| Recommendation | `APPLY` |
| Ranking decision | `SHORTLIST` |
| Candidate Fit | At least 75 |
| Deep Fit | At least 70 |
| Opportunity Quality | At least 70 |
| Final Priority | At least 75 |

The current version is `PIPELINE_POLICY_VERSION = 4.7.0`. Exact exclusion rules are returned in a bounded diagnostic trace; unresolved candidates remain in Registry/Research and may re-enter automatically after their evidence or evaluation becomes sufficient.

## Ranking and invariants

Pipeline rank is assigned only after admission and uses one stable ordering: Final Priority, Candidate Fit, Opportunity Quality, Deep Fit, source rank, and canonical Job ID. TODAY consumes this rank and never recomputes candidate quality. Every normal TODAY item therefore has the same rank as Pipeline; Human carryovers are explicit and unranked.

All discovery sources—including LinkedIn, Facebook communities, ATS feeds, and direct observations—enter Registry and pass this policy. No source receives automatic admission or priority.

Operational signals are reserved for actual defects: an admissible item not projected, duplicate active identity, terminal projected item, rank invariant failure, or policy contradiction. A small but valid Pipeline is healthy.
