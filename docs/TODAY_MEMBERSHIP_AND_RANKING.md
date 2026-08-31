# TODAY Admission, Refill and Ranking — V4.6

TODAY is the deterministic Human working set over the authoritative Job Registry. It is not a copy of Pipeline and it is not simply the ten highest-ranked postings.

## Capacity contract

`TODAY_TARGET = 10` is total row capacity. Every actionable, pinned, or held-visible row consumes one slot. Career Ops never lowers an eligibility threshold, bypasses a hard stop, creates a duplicate, invents a research task, or resurrects a terminal opportunity to reach ten.

After every projection boundary—Daily Runner, Sync Jobs, Human resolution, application confirmation, or other lifecycle completion—`selectTodayMembership()` recomputes the same working set from SQLite. There is no persisted Sheet-row refill state. The result is:

- `FILLED`: ten legitimate units were admitted;
- `EXHAUSTED`: fewer than ten were admitted and the complete candidate universe contains no other admissible unit;
- `BLOCKED`: a candidate that would otherwise qualify is missing required authoritative processing/ranking state.

An under-target `EXHAUSTED` result is healthy. `BLOCKED`, an admissible remainder outside an under-target set, a state contradiction, or a rank invariant failure is an operational defect.

Use `npm run today:diagnostics -- --trace` for the bounded, read-only Registry trace. It reports target, count, vacancies, outcome, every admitted row and reason, every candidate considered, exact exclusion rules, and exhaustion/block evidence. It never reads membership from the Sheet.

## Admission policy

Every admitted opportunity has exactly one internal reason:

- `HUMAN_ACTION`: one current Human decision/input is required. This includes a prioritized `VALID/APPLY` opportunity awaiting its first decision, evaluation/package review, application questions, verification, or exact reauthorization after a cancelled/not-applied attempt.
- `PINNED`: a governed asynchronous workflow is currently queued/running or an exact approved application is waiting for Career Ops. It belongs in the working set but does not count as Human attention.
- `HELD_VISIBLE`: an explicit current `HOLD` preserves the opportunity for later consideration. It consumes capacity, shows `ON_HOLD / On hold`, and does not count as Human attention.

Existing Human work, active workflow pins, and explicit holds are protected before new curated decisions. Within each policy tier the existing final-priority score, candidate-fit score, Registry snapshot rank, and stable Job ID provide deterministic order. TODAY consumes ranking; it does not define a second quality score.

A normal new decision is admissible only when the current snapshot says `ELIGIBLE + SHORTLIST`, the deep evaluation is `VALID + APPLY`, the opportunity is nonterminal, and a final priority exists. `READY` is not a blanket admission requirement: a valid application question, review, queued preparation, active execution, or explicit hold may use another stage. Conversely, `ELIGIBLE` alone is insufficient.

Explicit exclusions include terminal Human/application outcomes, Registry ineligibility/hard stops, non-shortlist ranking decisions, unresolved eligibility, incomplete machine evaluation, `DO_NOT_APPLY` without unresolved Human work, historical cancellation without a current workflow, and failed workflows without a governed Human action.

Multiple roles at one company remain distinct when Registry Job IDs are distinct. Duplicate copies of the same canonical Job ID are collapsed. Carryover has no independent admission power: it must still satisfy a current reason above.

## Human attention and instruction coherence

`Needs Your Attention` is the sum of projected TODAY rows whose canonical synthesized state sets `humanAttention = true`; it is never derived from row count. A true hold, background work, a non-actionable pin, and terminal history do not count.

Each attention row exposes one current instruction. Historical execution remains available in hidden lifecycle/debug state but cannot compete with the current visible `Status`, `Action`, and `Recommended Action`. In particular, a cancelled `NOT_APPLIED` attempt plus a current exact reauthorization requirement projects `WAITING_FOR_YOU / Authorize new attempt`; a true hold projects `ON_HOLD / On hold`. An unsafe HOLD-plus-action combination that is not a recognized current-work override produces a bounded `TODAY_STATE_CONTRADICTION` instead of guessing.

Machine `DO_NOT_APPLY` remains a recommendation, not a Human rejection. If the Human already chose `NEXT_STAGE` and the evaluation is ready for closure, the row remains actionable until `REJECT`, `HOLD`, or a policy-valid continuation resolves it.

`NEXT_STAGE` is dispatched by workflow stage:

- at `DECIDE`, it requests exactly one enrichment lifecycle;
- while enrichment is queued/running, it is a non-actionable pin;
- at `READY_FOR_REVIEW`, it means the evaluation/package requires the allowed Human closure decision;
- it never means `APPROVE_TO_APPLY`; that separate value authorizes one exact current job/package/plan.

## Projection invariants

TODAY contains at most ten unique entities. Physical order is sorted first; displayed Rank is then assigned exactly `1..N`. Terminal history alone cannot retain a row. Confirmed `APPLIED` leaves TODAY and projects exactly once in APPLICATIONS.

Human-owned values are merged by stable Entity ID, not row position, so refill and rank movement preserve unsynced answers, decisions, reasons, outreach choices, notes, and follow-up fields. The V4.5 writer remains unchanged: a legitimate refill emits bounded data diffs, layout version stays `4.5`, and a repeated unchanged projection emits zero writes.
