# Candidate Knowledge Base

The Candidate Knowledge Base (CKB) is the structured, user-owned evidence layer behind future evaluation and candidate-facing outputs. It is not a generated CV, cover letter, LinkedIn profile, or assessment.

```text
approved candidate sources
  cv.md
  config/profile.yml
  modes/_profile.md
  interview-prep/story-bank.md
          |
          v
candidate/ (user layer, never auto-updated)
          |
          v
CandidateKnowledgeProvider (read-only system boundary)
          |
          v
Deep Evaluation / future CV / interview consumers
```

## Ownership and source boundary

`candidate/` belongs to the user layer and is gitignored. System updates must not create, replace, or delete its contents. The system-owned code in `candidate-knowledge/` contains contracts and the provider, but no candidate facts.

The initial KB is an evidence-constrained bootstrap from approved local sources. `article-digest.md` was absent and was therefore not used. Reports, job postings, repositories outside Career Ops, auto-memory, and general model knowledge were not used as candidate evidence.

Bootstrap is intentionally curated rather than a generic prose-to-claim generator. Automatic extraction could turn ambiguous wording into unsupported claims. When approved sources change, review the affected structured entities, bump `kb_version`, update `metadata.updated_at`, run `npm run candidate -- hash`, place the returned hash in `manifest.yml`, and run `npm run candidate -- validate`.

## File topology

| File | Content |
|---|---|
| `manifest.yml` | Schema/KB versions, timestamp, content hash, approved sources, section routing |
| `identity.yml` | Defensible professional identity, positioning, domains, and target role types |
| `experience.yml` | Experience entities linked to responsibility claims and projects |
| `projects.yml` | Business problem, capabilities, architecture, technology, outcomes, evidence, and stories |
| `skills.yml` | Contextual skills with level, confidence, project evidence, and stories |
| `stories.yml` | Reusable interview knowledge; missing STAR fields remain null/partial |
| `gaps.yml` | Explicit unknown, partial, developing, or confirmed-absence boundaries |
| `preferences.yml` | Pointers into `config/profile.yml`; values are not duplicated |
| `evidence.yml` | Claims with status, confidence, approved source locators, and entity links |

## Evidence and safety model

Claims use `CONFIRMED`, `INFERRED`, or `UNKNOWN`:

- `CONFIRMED` requires at least one approved source reference and may support candidate-facing claims.
- `INFERRED` can assist internal exploration, must not have high confidence, and never authorizes a factual claim.
- `UNKNOWN` represents absent knowledge and never authorizes a claim.

The initial KB contains confirmed claims and explicit gaps; it adds no inferred claims. A gap may say that approved sources do not document a topic, but absence of documentation is not converted into “the candidate has no experience.” `CONFIRMED_ABSENCE` is available only for a future explicit statement from Jorge.

Skills use `demonstrated` rather than invented proficiency scales or years. Every skill links to projects and evidence. Projects preserve documented outcomes and leave undocumented decisions as empty arrays. Stories remain `PARTIAL` where situation, decisions, measurement details, or reflection have not been confirmed.

## Provider API

Future consumers use `CandidateKnowledgeProvider`; they do not parse YAML directly. It supports:

- `load()` / `getSnapshot()` / `getMetadata()`;
- `getIdentity()` and `getExperiences()`;
- `getProjects({ skill })` and `getSkills()`;
- `findEvidence(skill)`;
- `getGaps(topic)`;
- `getStoriesRelated({ skill, project })`;
- `getPreferences()` resolved from the canonical profile.

Unknown queries return a structured `UNKNOWN` result with empty evidence instead of guessing. All returned values are defensive copies.

## Versioning and determinism

The provider computes SHA-256 over normalized structured sections plus hashes of every approved source. `metadata.content_hash` must match or strict loading fails. Runtime metadata exposes:

```text
schemaVersion
version
updatedAt
hash
revision = version:hash-prefix
sourceHashes
```

The same files produce the same hash and query output. A source or KB edit changes the hash. Intentional knowledge revisions must also increment `kb_version`, allowing future evaluations to retain the exact KB revision they consumed.

The Discovery Strategy Engine resolves its user-owned `discovery_strategy` block through the preferences mapping. Search-only title or technology variants remain strategy terms and are not promoted into confirmed candidate claims.

## Local commands

```bash
npm run candidate -- validate
npm run candidate -- summary
npm run candidate -- skill RAG
npm run candidate -- project RAG
npm run candidate -- gap Kubernetes
npm run candidate -- preferences
npm run candidate -- hash
```

These commands are read-only. They make no model or network calls and do not modify Job Registry, Opportunity Ranking, or Daily Runner.

## Deferred scope

Deep Evaluation and Application Package Generator consume this provider and record the CKB revision used while preserving the confirmed/inferred/unknown boundary. There are still no embeddings, vector database, RAG runtime, recruiter discovery, scheduler, notification, automatic synchronization, or external delivery.
