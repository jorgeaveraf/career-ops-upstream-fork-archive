# Application question intelligence

`ApplicationQuestionResolver` is the shared question layer for Indeed, LinkedIn, Lever, Greenhouse, Ashby, Jobicy, and generic ATS forms. The browser extracts structured fields once from DOM/accessibility data—field ID, label, type, required state, options, current value, and semantic hint—and uses screenshots only as fallback evidence.

## Resolution order

1. Exact Candidate KB fact.
2. Exact application-plan answer.
3. Previous verified answer with matching semantic key and scope.
4. Deterministic derivation from trusted evidence.
5. Candidate policy.
6. Evidence-backed generated answer.
7. Human-required answer.
8. Sensitive external action.

Each answer records its original question, semantic key, value, resolution type, confidence, evidence references, application/job, reusable scope, validity date, and timestamps in schema-backed answer memory.

## Deterministic facts and experience

Identity, contact data, work authorization, sponsorship, language, and other exact facts come only from authoritative candidate sources. Experience-year answers merge verified calendar intervals so concurrent roles/projects are not double-counted, then use a conservative floor for numeric forms. The derivation retains its as-of date and evidence references so it can be refreshed over time. Generic software tenure is not treated as AI or skill-specific tenure.

English answers use the explicit candidate proficiency representation. C1 supports professional-fluency questions; missing or weaker evidence does not become “fluent” for screening convenience.

## Compensation and generated text

Compensation memory is scoped by employment type, period, currency, and relevant geography/basis. An hourly USD contractor policy cannot answer a monthly MXN contractor question, and contractor policy cannot silently answer annual employee compensation.

Summary, fit, interest, and relevant-experience text may be composed from the exact Candidate KB, job evidence, evaluation, and approved package. Generated answers are concise and job-aware and cannot invent employers, tools, metrics, or enthusiasm. Legal attestations remain human-required. Voluntary demographic answers are never inferred; decline/prefer-not-to-answer is used only under explicit policy.

## Memory, bundling, and efficiency

Questions normalize to stable semantic keys such as `experience.python.years`, `language.english.professional_fluent`, and `compensation.contractor.monthly_mxn`. Reuse requires matching semantics, compatible scope, current validity, and authoritative provenance. Stable platform patterns may be cached without hardcoding individual jobs.

The executor fills every safe known field before pausing and persists completed work. One application then exposes one bundle containing only unresolved required questions. A Sheet answer plus Sync Jobs resumes the same authorized execution without another approval.

Per-application metrics report inspected fields, deterministic, cached, derived, generated, human, sensitive, and LLM resolutions. Deterministic and cached paths run first; the current resolver makes zero LLM calls for identity, years, English, compensation policy, booleans, or reusable facts. Model reasoning is reserved for bounded free-text composition when deterministic evidence-backed templates are insufficient.
