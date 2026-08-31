# Deep Evaluation

Deep Evaluation answers a different question from opportunity ranking:

```text
assessment: should this opportunity receive attention?
evaluation: how strong is the evidence-backed candidacy and how should it be positioned?
```

The controlled flow is:

```text
latest SHORTLIST assessment
        |
        v
deterministic job analysis and requirement extraction
        |
        v
CandidateKnowledgeProvider evidence retrieval
        |
        +--> deterministic evaluation baseline
        |
        +--> optional structured LLM interpretation
                    |
                    v
              post-LLM validation
                    |
                    v
             EvaluationArtifact
                    |
                    v
        JobRegistry.recordJobEvaluation()
```

`deep-evaluation/` never imports SQLite. `CandidateKnowledgeProvider` remains read-only, and `registry/job-registry.mjs` remains the only persistence writer.

## Job and requirement model

`analyzeJob()` normalizes title, company, seniority, responsibilities, required/preferred signals, technologies, domains, employment model, location model, and hidden operating signals. The initial extractor is deterministic and conservative; unrecognized prose remains in the source observation instead of being guessed.

Every recognized requirement has a stable ID, one of `skill`, `technology`, `architecture`, `domain`, `experience`, `soft_skill`, `seniority`, or `business_context`, an importance, `must_have`/`nice_to_have`/`supporting` priority, required evidence entity types, and its source excerpt.

Evidence matching uses only `CandidateKnowledgeProvider`. Results are `STRONG_MATCH`, `PARTIAL_MATCH`, `TRANSFERABLE_EXPERIENCE`, `NO_EVIDENCE`, or `CONFLICTING_EVIDENCE`, with explicit claim/project/skill/story/gap IDs. The initial transfer rule recognizes Docker/container deployment as adjacent evidence for Kubernetes, but keeps Kubernetes at `PARTIAL_MATCH` and retains `gap.kubernetes`. It never converts adjacency into Kubernetes ownership.

Gaps remain distinct:

- `missing`: no approved evidence or an `UNKNOWN` knowledge boundary;
- `weak`: related evidence does not prove the requirement;
- `developing`: the CKB explicitly says `DEVELOPING`;
- `confirmed_absence`: the CKB explicitly says `CONFIRMED_ABSENCE`.

## Optional LLM layer

`StructuredGenerationProvider.generateStructured()` is the provider boundary. Increment 5B includes one network adapter, `OpenAIResponsesProvider`, but the engine only sees the abstract method. The adapter uses the Responses API with a strict JSON schema and `store: false`. A model identifier must be explicitly configured through `CAREER_OPS_DEEP_MODEL` or `CAREER_OPS_MODEL`; there is no silent model default.

The model receives only structured job analysis, requirement-level evidence, relevant approved evidence excerpts, known gaps, and CKB metadata. Job text is declared untrusted data. The prompt prohibits unsupported skills, projects, metrics, scope, and ownership.

Post-generation validation is authoritative. It checks recommendation/confidence/fit bounds, requirement IDs, requirement-scoped evidence IDs, known gap IDs, unsupported metrics, strengths without evidence, and expertise claims that overstate partial evidence. Invalid output becomes a `REJECTED` artifact with validation errors and the rejected output for audit; it is never exposed as an accepted evaluation.

## Structured artifact and versioning

A valid evaluation contains:

```text
recommendation  APPLY | CONSIDER | DO_NOT_APPLY
confidence      HIGH | MEDIUM | LOW
overall_fit     0..100
summary
strengths       requirement IDs + evidence IDs
evidence_used   approved entity IDs
gaps            requirement IDs + gap IDs + status
positioning     evidence-backed emphasis and avoid list
interview_focus topics + evidence IDs
risks           requirement IDs + evidence IDs
```

The artifact also retains deterministic job analysis and evidence matches. Its identity hashes job/observation/assessment identity, CKB hash, engine version, prompt version, provider, model, and job-analysis hash. A relevant version change appends a new evaluation rather than replacing history.

Migration `004_job_evaluations.sql` stores evaluations separately from `job_assessments`. Both `VALID` and `REJECTED` attempts are auditable. The table contains no CV text, credentials, API keys, or full CKB snapshot.

## Cost gate and commands

Deep evaluation is never part of discovery, scanning, Daily Runner, or ranking. The engine rejects anything other than the latest `SHORTLIST` assessment before a provider call.

```bash
# inspect latest shortlist candidates; no model call
npm run deep-evaluate -- pending --limit 100

# deterministic baseline; explicit persistence
npm run deep-evaluate -- evaluate --job <job-id>

# optional structured OpenAI evaluation; one explicit call
CAREER_OPS_DEEP_MODEL=<model-id> npm run deep-evaluate -- evaluate --job <job-id> --llm

# inspect evaluation history
npm run deep-evaluate -- show --job <job-id>
```

Tests use fixtures and injected providers. They make no live model calls.

## Known limitations and deferred scope

The initial phrase extractor is intentionally not a general natural-language parser. Its vocabulary and transfer rules are versioned and currently English-oriented. Evidence retrieval is deterministic lexical/entity matching without embeddings or vector storage. Post-LLM validation strongly constrains references and metrics, but free-form semantic entailment is not a formal proof system; rejected attempts remain visible for review.

The separate Application Package Generator may consume a valid APPLY evaluation to prepare resume, cover-letter, outreach, and note drafts. Deep Evaluation itself still does not generate those artifacts. PDFs, applications, recruiter/contact data, notifications, browser actions, Google data, and scheduled work remain outside this layer.
