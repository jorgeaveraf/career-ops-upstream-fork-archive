# Pipeline Admission, TODAY Selection and Ranking — V4.7

Career Ops has three deliberately different universes:

- **Registry** is the authoritative observed and historical universe. Discovery from every source lands here first.
- **Pipeline** is every current active opportunity Career Ops believes is genuinely worth pursuing.
- **TODAY** is Pipeline ranks `1..MIN(10, Pipeline count)`, plus only governed Human lifecycle carryovers.

The Sheet is a projection. Membership is always recomputed from SQLite and never refilled from physical rows or an earlier snapshot.

## Pipeline admission contract

`PipelineAdmissionPolicy` version `4.7.0` is the single normal-admission gate. A candidate must be active and unique, have resolved `ELIGIBLE` eligibility, sufficient job evidence, a current valid deep evaluation, `APPLY`, shortlist membership, Candidate Fit at least 75, Deep Fit at least 70, Opportunity Quality at least 70, Final Priority at least 75, and Evidence Confidence at least `MEDIUM`. Terminal applications, Human `REJECT`, hard stops, unresolved/unknown eligibility, incomplete evaluation, `DO_NOT_APPLY`, insufficient evidence, and duplicate canonical Job IDs are excluded.

The thresholds determine admission; they do not create a second rank. Admitted candidates are ordered deterministically by Final Priority, Candidate Fit, Opportunity Quality, Deep Fit, source rank, then stable Job ID. Pipeline is unbounded. The same authoritative input therefore produces the same membership and order.

`APPLY` means the machine recommends serious pursuit after the other gates pass. It is not application authorization. `APPROVE_TO_APPLY` remains the separate exact Human authorization for one job/package/plan. `DO_NOT_APPLY` is excluded from normal Pipeline even when Human closure is still required.

## TODAY contract

`TODAY_TARGET = 10` applies to the normal curated Pipeline slice. TODAY takes Pipeline ranks 1 through 10 without rescoring or renumbering them. When a ranked item becomes terminal or rejected, the next Pipeline rank promotes naturally. When Pipeline contains fewer than ten strong active candidates, normal TODAY remains below ten; Registry candidates never bypass admission to fill capacity.

A Human lifecycle carryover may appear after the normal slice when there is a governed current obligation such as an application question, exact reauthorization, evaluation closure, or an active background workflow. It is labeled `HUMAN_CARRYOVER`, has no Pipeline rank, and does not contaminate Pipeline quality metrics. Historical state alone cannot create a carryover.

## HOLD and Human attention

A strong admitted candidate with Human `HOLD` remains a ranked Pipeline candidate when the opportunity is still active and all quality gates remain true. Its visible state is `ON_HOLD`; it does not count as current Human attention. A weak or excluded opportunity cannot enter Pipeline merely because it is held. A separate carryover requires an independently valid lifecycle reason.

`Needs Your Attention` counts rows whose synthesized current state requires one Human action. It is never derived from Pipeline count, TODAY count, hold state, or pin state. Visible Status, Action, Recommended Action, and Attention Type must tell one coherent current story; rich historical execution state remains internal.

Machine `DO_NOT_APPLY` can coexist with unresolved Human review authority. In that case the opportunity stays outside Pipeline but may appear as an unranked `HUMAN_CARRYOVER` until `REJECT`, `HOLD`, or a valid continuation resolves it. Supabase-style cancelled/`NOT_APPLIED` history similarly remains historical; if a new exact authorization is required, the current carryover says so without presenting the opportunity as a normal pursuit candidate.

## Diagnostics and projection

Run `npm run pipeline:diagnostics -- --trace` for Registry totals, admission count, exclusion rules, ranks, thresholds, and quality metrics. Run `npm run today:diagnostics -- --trace` for the normal Pipeline slice, Human carryovers, final count, attention count, and underfill explanation.

Projection preserves stable Entity IDs and Human-owned cells. The V4.7 structural version is required because PIPELINE's visible schema now exposes the unified rank and strong-candidate evidence. Initialization occurs once; subsequent unchanged pushes use zero Sheet writes. Confirmed applications continue to leave TODAY and appear exactly once in APPLICATIONS.
