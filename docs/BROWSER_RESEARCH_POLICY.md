# Browser Research Capability

Browser Research is a separate `research_only` evidence-acquisition run. It supplements existing providers; it does not replace Discovery or write directly to canonical tables.

```text
Research tasks -> BrowserResearchProvider -> validated Acquisition Result
               -> Registry Boundary -> evidence + optional canonical job observation
```

The Browser Discovery LaunchAgent runs first at 15:30 (`America/Mexico_City`) and invokes `npm run browser:research -- --scheduled --json`. The core `npm run daily:auto` follows at 16:00 to reconcile the full Registry, evaluate/package qualified candidates, refresh the operational Sheet, and decide notifications from the final same-day state.

## Commands

```bash
npm run browser:research -- --dry-run
npm run browser:research -- --dry-run --json
npm run browser:research -- --json
npm run browser:research -- --discover --dry-run --json
npm run browser:research -- --discover --source linkedin --query "AI Systems Engineer" --max-results 5
npm run browser:research -- --scheduled --json
npm run browser:research -- --help

npm run browser:launch-agent -- generate
npm run browser:launch-agent -- install
```

Dry-run loads task configuration and reports the plan. It does not inspect Chrome, acquire locks, open a database, or navigate.

## Required configuration

Create the gitignored `config/browser-research.json` from `config/browser-research.example.json`, then configure:

```dotenv
BROWSER_PROFILE=jorge
BROWSER_MODE=research_only
BROWSER_USER_DATA_DIR=/absolute/path/to/existing/chrome/user-data
BROWSER_RESEARCH_CONFIG=config/browser-research.json
BROWSER_SESSION_NAME=career_ops
BROWSER_SESSION_KIND=managed_window
BROWSER_SESSION_LOCK=data/browser/.careerops-session.lock
```

The session manager reads Chrome's existing `Local State` and requires exactly one profile whose displayed name is `Jorge`. `Brunova`, `HQ`, ambiguous mappings, missing directories, and every non-`research_only` mode fail closed. It neither copies nor exports a profile.

## Managed Research Window and lock policy

Browser Research atomically owns `data/browser/.careerops-session.lock`. The lock represents one Career Ops Research Session—not ownership of Chrome or of the Jorge profile. It records version, session ID, PID, timestamps, profile, session name, state, and the Career Ops window ID when available. A second live Career Ops session fails closed; a stale Career Ops lock may be reclaimed.

Chrome may already be open and the user may continue using existing Jorge windows. Career Ops creates one distinct managed window, records its ID, creates only tabs inside that window, and closes only those tabs and that window. Existing window IDs are never added to the owned-resource set and all driver operations reject non-owned IDs. Career Ops never closes Chrome globally, switches an existing tab, or manages Brunova/HQ resources.

The managed window is a new normal Chrome window and `managed_window` is currently the only accepted `BROWSER_SESSION_KIND`. It shares the Jorge profile's existing cookies, authenticated sessions, preferences, and personalization without copying or exporting them. Career Ops starts the window on a unique local `file:///dev/null#…` marker derived from the Career Ops session ID and claims it only when both the exact marker and Chrome's `normal` mode match. The marker performs no network request and distinguishes the window from a user-created window during concurrent activity.

## Research and Discovery are separate

Research reads pages for company context and evidence. Discovery finds job cards and returns `RawJobPosting`. They share only the research-only browser/session layer:

```text
Research  -> BrowserResearchProvider -> browser evidence tables
Discovery -> BrowserJobSearchProvider -> Acquisition Contract -> Job Registry
```

Discovery can be invoked manually with `--discover`. In the scheduled window, `--scheduled` runs bounded job-source discovery, read-only monitoring of already joined/approved Facebook communities, and bounded priority enrichment sequentially through one Browser Research orchestration. A Facebook failure degrades that source without stopping the others. It does not invoke or modify `daily:auto`; the core worker performs final convergence.

The scheduled lane is:

```text
Browser Discovery tasks -> Acquisition Result -> Registry Boundary
                        -> scoped eligibility/ranking
                        -> provider-quality metrics
                        -> optional SOURCE_METRICS sheet
```

With `browser_discovery.useDiscoveryStrategy` enabled, scheduled and ordinary discovery compile Candidate-KB-backed platform runbooks from `config/profile.yml`; see `DISCOVERY_STRATEGY.md`. Runbooks exist for LinkedIn, Indeed, and OCC. V4 additionally invokes bounded read-only Facebook monitoring for eligible communities in the same scheduled orchestration. LinkedIn personalized-feed discovery, Indeed discovery, and OCC discovery remain outside the original V1 support claim. An explicit CLI `--query` uses the direct one-query fallback, while `--source` filters the strategic task plan and `--max-results` retains its normal cap.

## Tasks and evidence

Configured tasks cover:

- job discovery for AI Systems Engineer, AI Platform Engineer, Senior AI Engineer, Data Engineer, and Solutions Architect with remote, senior, technology, contractor-preferred, and LATAM/global task filters;
- small source adapters for LinkedIn Jobs, Indeed, and OCC, plus joined/approved-community Facebook monitoring normalized into the same Registry;
- company careers pages, public hiring signals, and team information for registry companies;
- public identification of a recruiter, hiring manager, or engineering lead, without contact.

The Research adapter remains generic and records low-confidence `PAGE` evidence. Discovery adapters extract only URL, title, company, location, modality, short description, source, and timestamp from bounded result cards. Missing fields are `UNKNOWN`; they do not attempt advanced parsing.

Every accepted observation has an HTTP(S) URL, retrieval timestamp, source, extraction method, confidence, evidence, content hash, run/task/provider provenance, Jorge profile directory, `RESEARCH_ONLY` mode, and an empty performed-actions list. A contact relationship without direct evidence is stored as `UNKNOWN`; unsupported “looks like a recruiter” conclusions are invalid.

Browser providers never receive SQLite. Research passes evidence to `recordBrowserResearchResults`. Discovery maps provider results through `toNormalizedObservation()` and then the existing `recordObservations()` registry boundary. It therefore reuses strong external-ID/canonical-URL identity and does not introduce new fuzzy deduplication.

Discovery records source/query status and duration in `run_provider_results`, plus per-source found, valid, and duplicate totals. Schema 11 additionally records the strategy mode, explanation, rejections, and exact task-observation links. Eligible, shortlist, evaluation, and package-ready counts are derived from existing Registry artifacts per provider and strategy. Provider ROI is `SHORTLIST / DISCOVERED`; Evaluation ROI is `PACKAGE_READY / DISCOVERED`. `getProviderPerformance()` provides a comparable view across core and `browser:*` sources but never selects or disables a provider automatically.

If Sheets credentials are available, the scheduled lane refreshes only the optional `SOURCE_METRICS` tab. Its columns are provider, strategy, discovered, valid, duplicates, eligible, shortlist, evaluated, package ready, both ROI values, and last run. The six operational tabs retain their existing contracts and contents.

## Research-only enforcement and data safety

The policy permits research intents: navigate, search, read, filter, scroll, open a result, and extract evidence. It denies application, submission, upload, send, message, connect, accept-connection, post, comment, publish, react, follow, and profile-mutation intents. The current managed adapter exposes research reads and bounded discovery only; it has no application, messaging, social, upload, or mutation methods. It opens URLs only in tabs whose IDs were created inside the owned Career Ops window. Page content is untrusted data, never instructions.

Career Ops does not store or export cookies, passwords, tokens, browser sessions, or profile copies. Because the managed window is normal, research navigation can appear in the Jorge profile's shared browser history and can affect server-side analytics, recommendations, or viewed-state. `research_only` means no intentional application, communication, social, or account mutation—not network invisibility or zero personalization impact.

Authentication prompts, CAPTCHA, required forms, unclear profile selection, unavailable Chrome automation, and an active Career Ops session fail closed. No automatic login or CAPTCHA bypass exists.

## Logs and current limitations

Structured Research events are written under `logs/browser/`. Discovery query/source/duration/result/error and lock outcomes are written under `logs/browser/discovery/`. Logs are private and gitignored; they do not contain cookie/session exports.

Current limitations: the managed-window driver currently requires macOS, Google Chrome, and permission for Career Ops to automate Chrome. Without “Allow JavaScript from Apple Events”, Research falls back to low-confidence URL/title evidence from the owned tab, while Browser Discovery fails closed because structured DOM extraction is unavailable. A normal window inherits logged-in sessions but also shares profile history and personalization. Discovery uses intentionally small selectors that may need maintenance when source markup changes; it reads at most 10 cards per task by default (configurable up to 50); dynamic sites may block automation; no live quality baseline has been run; and the Mac must be awake/logged in. Core providers historically persist accepted observation counts rather than every pre-validation result, so their `discovered` baseline is not perfectly symmetric with browser card counts. The scheduled window performs acquisition and scoped ranking, but not deep evaluation or package generation; those metrics remain zero until such downstream artifacts exist. There is no application, outreach, message, LinkedIn/Facebook action, form workflow, or automatic provider decision.
