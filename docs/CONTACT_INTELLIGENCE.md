# Contact Intelligence 2.0

Contact Intelligence identifies the most relevant reachable humans connected to an opportunity during preparation. It is a bounded public-research layer, not an email finder and not an external-action layer.

The default budget is 6 queries, 8 pages, 12 browser minutes, and 5 retained candidates. Queries adapt to the role family and cover the original posting/ATS, company careers and team pages, public LinkedIn profiles/search, public web results, recruiter/talent pages, function leadership, and official recruiting routes. Fresh evidence is reusable across jobs at the same company through the consolidated company/person registry.

Results rank a single `PRIMARY_CONTACT`, then limited `SECONDARY_CONTACT` or `GENERAL_RECRUITING` routes. Supported contact types include recruiter, talent acquisition, hiring manager, team lead, functional leader, engineering manager, solutions leader, founder, and other relevant public contacts. Confidence is `HIGH`, `MEDIUM`, or `LOW`; low-confidence candidates are never presented as authoritative.

`NONE_VERIFIED` is valid only when the bounded search completed and found no reliable person. `BLOCKED` records source/auth/challenge failure explicitly. A public profile without email remains useful. Public email is accepted only as direct attributable evidence; the system never infers an address from a naming pattern.

## Architecture

```text
Job Registry + ready Application Package
                |
                v
       ContactIntelligenceEngine
                |
      +---------+----------+
      |         |          |
   Company    People   Relationships
      +---------+----------+
                |
        Outreach Strategy
                |
       Human review and action
```

The engine in `contact-intelligence/` is deterministic and has no persistence dependency. `JobRegistry` remains the only SQLite writer. `contacts.mjs` and `data/contacts.tsv` remain the user-controlled phonebook; discovered people are never copied there automatically.

## Models and evidence

A company can contain name, domain, relevant URLs, careers URL, description, industry, products, visible technologies, and public-culture observations. A person can contain identity, company, role, public profile URL, status, confidence, and evidence. Optional facts are retained only when field-level evidence supports the value.

Evidence records include the field, value, confidence, extraction method, provider ID/version, public source type/URL, source hash, and retrieval time. Social/authenticated URLs are rejected by normalization. A person needs evidence for both identity and company affiliation; otherwise the record remains `UNKNOWN`.

Relationship types are `RECRUITER`, `HIRING_MANAGER`, `ENGINEERING_LEAD`, `TEAM_MEMBER`, `COMPANY_CONTACT`, and `UNKNOWN`. A provider-supplied relationship is accepted only when relationship evidence directly supports the same type. Evidenced role titles may be conservatively normalized: an engineering team member is never treated as a hiring manager.

`outreachStrategy` contains only a recommended path, reasoning, and confidence. It creates no message content and triggers nothing.

## Provider boundary

Future public-source adapters implement `ContactDiscoveryProvider` with `findCompany`, `findPeople`, and `findRelationships`. No concrete external provider is included in Increment 7. Providers return observations and never receive the registry, browser state, credentials, or an action client.

## Persistence and versioning

Migration `006_contact_intelligence.sql` adds separate tables for canonical companies and people, append-only evidence, job-company links, versioned `contact_research`, and relationships observed in each research version.

Company identity is consolidated by evidenced domain, then normalized name. Person identity is consolidated by public profile URL, then normalized name within the company. Research identity includes the job, optional package, engine/provider versions, and a stable source hash. Retrieval timestamps alone do not create a new version; changed source content does.

## Application Package relationship

`buildApplicationPackageContactContext()` exposes a read-only context that a later package consumer can use. Contact Intelligence does not mutate or regenerate Application Packages. Persisted research can reference the package that made the job eligible for research.

## CLI

```bash
npm run contact-intelligence -- pending
npm run contact-intelligence -- research --job <job-id>
npm run contact-intelligence -- show --job <job-id>
```

`research` requires the latest valid `DRAFT` or human-approved Application Package. Because no external provider exists yet, it records only company evidence already present in the Job Registry.

## Human boundary

Every artifact preserves its bounded search report, sources, verification time, completion state, ranked primary result, and evidence. The system performs no contact, delivery, connection, email, DM, or application action. The next step is always human review.

## Known limitations

- No concrete discovery source is configured, so the default CLI cannot discover people or enrich a company beyond registry evidence.
- Name/domain consolidation is intentionally conservative and may require a future human merge/split control.
- Role-to-relationship normalization is limited to explicit title semantics; it does not predict reporting lines or hiring ownership.
- There is no Google Sheets control plane in this increment.
