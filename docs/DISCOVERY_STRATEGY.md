# Discovery Strategy Engine

The Discovery Strategy Engine turns Jorge's approved Candidate Knowledge and explicit search preferences into deterministic, explainable platform tasks. It is a local planning and filtering layer, not a scraper.

```text
CandidateKnowledgeProvider + config/profile.yml discovery_strategy
                         |
                         v
               compiled strategy revision
                         |
                         v
               platform-specific runbooks
                         |
                         v
             Browser Discovery task plan
                         |
                         v
            Acquisition -> Registry Boundary
```

`daily:auto` does not import or invoke this engine. The consumer is the separate manual/scheduled Browser Discovery lane.

## Ownership and evidence

The user-owned `config/profile.yml` contains `discovery_strategy`. `candidate/preferences.yml` points to that block, and the engine reads it through `CandidateKnowledgeProvider.getPreferences()`. Primary/alternative roles, confirmed technologies, domains, remote policy, employment preference, regions, and seniority therefore come from Candidate KB rather than a second keyword list.

Explicit search variants and terms such as AI Platform Engineer, LLM Engineer, LangGraph, LangChain, and GCP are labeled as search terms; they are not converted into candidate skill claims. The compiled strategy carries both its own revision and the exact Candidate KB revision.

## Platform runbooks

- `linkedin_feed`: first reads personalized recommended jobs. It has high hidden-opportunity priority and precedes all LinkedIn searches.
- `linkedin_search`: searches candidate roles and technologies with remote, senior, LATAM/Mexico/worldwide, and contractor-preferred context.
- `indeed_search`: coverage-oriented explicit remote queries.
- `occ_search`: Mexico-market Spanish/English queries.
- `facebook_group`: plans discovery of active technical communities.
- `facebook_monitoring`: is empty until specific groups are approved.

Facebook tasks are `planned_only`. They are visible in the strategy plan but excluded from executable Browser Discovery because 10E adds no Facebook scraper or social action capability.

## Global rules

`micro1` and `bairesdev` are exact normalized hard rejects. Configured talent-network/pool/marketplace phrases can either reject or apply a deterministic priority penalty. The current policy penalizes those observations by 25 final-priority points and records the matched phrases in observation metadata.

Compensation uses three strategy states:

- `KNOWN`: directly comparable evidence meets the relevant threshold.
- `BELOW_THRESHOLD`: comparable evidence is below MXN 40,000 net/month for a foreign company or MXN 50,000 net/month for a Mexican company.
- `UNKNOWN`: salary, company market, currency, period, basis, or evidence is insufficient.

Unknown compensation is never rejected. A below-threshold exceptional opportunity retains `BELOW_THRESHOLD` but does not auto-reject. Currency, period, market, or gross/net conversion is never inferred.

## Facebook authenticity

The pure authenticity scorer rewards visible application email, identifiable company, complete description, defined stack, clear responsibilities, and visible salary. Talent-pool, community-only, spam, registration-funnel, and marketplace signals reduce the score. It returns a bounded 0-100 score, band, and reasons; it performs no navigation or action.

## Explainability and metrics

Every task includes source, strategy ID, mode, objective, priority dimension, filters, reason, matched signals, strategy revision, and Candidate KB revision. Task IDs and ordering are deterministic.

Schema version 11 records per-task source, strategy, query, status, timestamps, discovered, valid, rejected, duplicates, errors, explanation, and linked Registry observations. Strategy metrics retain the existing funnel counters and calculate Provider ROI and Evaluation ROI per `linkedin_feed`, `linkedin_search`, `indeed_search`, or `occ_search`. Optional `SOURCE_METRICS` rows include a `Strategy` column; the six main control-plane tabs are untouched.

## Local commands

```bash
npm run discovery:strategy -- summary
npm run discovery:strategy -- tasks
npm run discovery:strategy -- explain <task-id>
npm run browser:research -- --scheduled --dry-run --json
```

The strategy command and dry-run do not open Chrome or write Registry state.

## Limitations

- No auto-learning or outcome-driven strategy mutation exists.
- Company jurisdiction and net compensation must be evidenced; otherwise compensation stays `UNKNOWN`.
- Platform markup and personalized feeds remain external and unstable.
- The current browser adapter extracts a bounded visible result set; it does not implement automated infinite scrolling for the LinkedIn feed.

V1 release claims are narrower than the available strategy catalog: LinkedIn targeted search is supported, while the personalized feed, Indeed discovery, OCC discovery, and Facebook community discovery are not included in V1. The last controlled feed attempt ended in a platform challenge and was not repeated or bypassed.
- Facebook discovery and monitoring remain planned-only.
- No apply, form, message, connection, outreach, profile mutation, or social action exists.
