# Browser Runbook Executor

Career Ops executes browser work as a read-only semantic state machine. Page navigation is not success by itself.

## Execution model

The persisted states are `PLANNED → NAVIGATING → PAGE_CLASSIFIED → RESULTS_WAITING → RESULTS_READY → SCROLLING → EXTRACTING → VALIDATING → COMPLETE`. A task ends with exactly one semantic outcome: `SUCCESS_RESULTS`, `SUCCESS_EMPTY`, `AUTH_REQUIRED`, `CHALLENGE`, `CAPTCHA`, `WRONG_PAGE`, `SELECTOR_CHANGED`, `RESULTS_TIMEOUT`, `NAVIGATION_TIMEOUT`, `EXTRACTION_FAILED`, or `POLICY_BLOCKED`.

Classification uses the final URL, title, visible text, DOM readiness, selector matches, and extracted card count. Authentication is observed only from login/checkpoint/captcha evidence; it is never inferred from a successful navigation.

## Runbooks and budgets

Versioned runbooks exist for LinkedIn recommendations, LinkedIn search, Indeed search, OCC search, and candidate enrichment. Indeed recommendations are `not_supported`; the provider remains search-first. Facebook remains `planned_only` and is not executable.

## V1 capability boundary

The executable code retains the LinkedIn feed runbook for diagnostics and future validation, but the final controlled live attempt ended `CHALLENGE`. Career Ops stopped without retrying or bypassing it. V1 therefore claims LinkedIn **targeted search only**; personalized recommendations are `NOT_INCLUDED_IN_V1`. Indeed and OCC discovery are also excluded from V1 claims until each completes a post-11D controlled validation. Priority evidence enrichment remains supported.

`config/browser-research.json` controls navigation/readiness polling, total task duration, scroll passes and duration, stable passes, card/detail limits, total tasks, per-source tasks, and the research-window duration. The shipped scheduled bound is eight discovery tasks, no more than three per source, followed by at most five enrichment candidates.

LinkedIn recommendation success requires at least one scroll pass unless the page explicitly reports an empty state. Targeted searches confirm the requested query against the resulting URL/title/page content. OCC persists result fingerprints and warns when different queries produce the same result set.

## Discovery

Cards are deduplicated by external job ID, canonical URL, or source URL. Company/title alone is not a browser-card identity. Detail acquisition is bounded and extracts title, company, location, description, employment type, compensation text, posting date, application path, and canonical URL. Invalid source records are counted with rejection reasons before the Acquisition Result crosses the Registry Boundary.

## Enrichment

`PriorityResearchPlanner` consumes only navigable `OPEN` candidate research needs. It orders TOP 10 candidates first, then high-priority needs, expected candidate value, evidence completeness, and freshness. Evidence-source order is the candidate canonical/ATS URL when available, then its source posting. Generic search is not used automatically.

The resolver stores raw evidence with URL, source, retrieval timestamp, extraction method, confidence, and resolver version. Candidate identity must match by canonical URL or title plus company. A mismatch produces `EVIDENCE_IDENTITY_UNCERTAIN`; evidence is not attached. Resolved needs queue only that candidate for reassessment, and the daily priority snapshot is rebuilt after the bounded batch. Enrichment never generates application packages and does not refresh Google Sheets.

## Scheduling and commands

The `com.careerops.browser-research` LaunchAgent remains separate and runs at 15:30 America/Mexico_City. Its sequential worker performs V1-supported LinkedIn targeted search first and priority enrichment second, with no concurrent Chrome sessions. The 16:00 core worker then finalizes the same-day candidate set, Sheet, and notification state.

```bash
npm run browser:research -- --mode DISCOVERY --dry-run --json
npm run browser:research -- --mode ENRICHMENT --max-tasks 5 --dry-run --json
npm run browser:research -- --report --json
npm run browser:research -- --report --run-id <run-id> --json
```

`--discover` remains supported. Use `--no-sheet` for validation runs that must not refresh `SOURCE_METRICS`.

## Safety boundary

Only navigation, search, reading, filtering, scrolling, opening results, and evidence extraction are allowed. The executor exposes no apply, submit, upload, message, connect, publish, profile mutation, or form-submission operation. It uses the existing local Chrome profile, stores no cookies/passwords/session exports, and closes only tabs/windows owned by Career Ops.

## Limitations

- Selectors are versioned but still depend on third-party DOMs; drift terminates as `SELECTOR_CHANGED`.
- Dynamic pages may return challenge, captcha, or timeout outcomes and require a later human-authenticated run.
- Compensation normalization preserves the raw advertised string; currency/basis inference is intentionally conservative.
- Company-market and schedule needs remain open unless the page states direct evidence.
- No OCR, recruiter/contact enrichment, outreach, application, form action, or provider learning is included.
