# Application Package Generator

Application Package Generator prepares evidence-backed drafts after a positive Deep Evaluation. It does not render PDFs, contact people, or submit applications.

```text
VALID APPLY job evaluation
        +
CandidateKnowledgeProvider
        +
canonical cv.md (read-only)
        |
        v
ApplicationPackageEngine
        |
        +-- Resume Variant
        +-- Cover Letter Draft
        +-- Recruiter / Hiring Manager / Email Drafts
        +-- Application Notes
        |
        v
post-generation evidence validation
        |
        v
ApplicationPackage artifact
        |
        v
JobRegistry.recordApplicationPackage()
        |
        v
Human review only
```

The engine in `application-package/` has no SQLite or file-write dependency. It receives canonical CV text from its caller and never modifies `cv.md`, `candidate/`, or a job evaluation. The Job Registry remains the only database writer.

## Package model

An application package has an immutable content identity and a separate review lifecycle:

- `DRAFT`: generation and validation passed; awaiting a person.
- `REVIEW_REQUIRED`: validation rejected the generated output; it cannot be used as an accepted draft.
- `APPROVED`: a person explicitly approved a valid draft.
- `ARCHIVED`: retained history, no longer active.

Approval changes only registry state. It triggers no network, messaging, rendering, form-fill, or application action.

The structured artifacts are:

- `resume_variant`: adapted summary, ordered supported skills, selected projects, experience emphasis, requirement keywords, and an auditable list of changes from the canonical CV. Unselected experience is preserved by default.
- `cover_letter`: sourced paragraphs and their exact composed content.
- `outreach`: recruiter message, technical hiring-manager message, and professional email introduction. These are drafts with no contact lookup.
- `application_notes`: why apply, strongest arguments, concerns, interview focus, questions, and a non-invented salary note.

## Evidence and claim safety

The package can use only evidence IDs selected by the accepted evaluation and still present in the current Candidate Knowledge Base. `CONFIRMED` claims are the factual boundary. Gaps and inferred/unknown claims cannot be used as positive evidence.

Candidate-facing factual fragments retain `evidence_refs`; role/company context retains `requirement_refs`. Adaptations are marked as `DIRECT`, `WORDING_ADAPTATION`, or `JOB_CONTEXT`. `WORDING_ADAPTATION` permits reframing but not stronger claims.

Validation checks:

- evidence, requirement, skill, project, and experience IDs;
- cover content against its sourced paragraphs;
- all three personalized outreach types;
- metrics against the canonical CV and selected evidence;
- known gaps, expertise claims, and unsupported superlatives;
- positive content without candidate evidence.

Invalid model output is stored as a `REVIEW_REQUIRED` / `REJECTED` attempt for audit, never as accepted artifacts.

## Deterministic and optional model paths

The deterministic path is the default and produces a complete structured draft without a model call. An optional model uses the existing `StructuredGenerationProvider.generateStructured()` abstraction from Deep Evaluation. The provider receives only job analysis, accepted evaluation, structured canonical-CV metadata, and selected evidence—not repository access.

## Persistence and versioning

Migration `005_application_packages.sql` adds an append-only `application_packages` table, separate from assessments and evaluations. It records:

- job and evaluation IDs/identity;
- sequential package version per job;
- CKB version/hash/revision;
- canonical CV hash;
- engine and prompt versions;
- provider/model and usage;
- artifacts or rejected output;
- evidence references, validation, timestamps, and human-review state.

The package key includes the evaluation content hash, CKB hash, CV hash, prompt/engine versions, provider, and model. An identical request is idempotent; any relevant content/version change creates a new historical package version.

## Commands

```bash
# inspect latest VALID APPLY evaluation candidates
npm run application-package -- pending --limit 100

# deterministic draft, persisted in the registry
npm run application-package -- generate --job <job-id>

# optional structured model draft
CAREER_OPS_PACKAGE_MODEL=<model-id> npm run application-package -- generate --job <job-id> --llm

# inspect package history
npm run application-package -- show --job <job-id>

# explicit human review state change; no external action
npm run application-package -- review --package <package-id> --status APPROVED
```

Existing CV/cover HTML and PDF renderers may consume an approved structured package in a later explicit workflow. Generation does not call them automatically.

## Known limitations and deferred scope

The deterministic prose is English-oriented and intentionally conservative. Company-specific motivation is limited to facts available in job analysis; no company research is performed. Semantic validation is evidence-ID and rule based rather than a formal entailment proof. There is no contact research, recruiter discovery, email/LinkedIn integration, browser automation, form submission, PDF generation, scheduler, notification, or automatic application.

