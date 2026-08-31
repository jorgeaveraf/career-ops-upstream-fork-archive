# Acquisition Layer

Career Ops discovery uses one acquisition pipeline without giving providers persistence access:

```text
provider.fetch()
      |
      v
acquireProvider() -> AcquisitionResult<RawJobPosting[]>
      |
      v
normalization + provenance + evidence
      |
      v
scan.mjs -> JobRegistry
```

The opt-in Browser Discovery lane uses the same middle and lower boundaries:

```text
BrowserJobSearchProvider.acquire() -> AcquisitionResult<RawJobPosting[]>
                                   -> toNormalizedObservation()
                                   -> JobRegistry.recordObservations()
```

It is invoked only with `npm run browser:research -- --discover`; it is not part of `daily:auto`.

`fetch()` remains the compatibility API for existing providers and their direct tests. The provider loader also exposes `acquire()`, and the scanner uses this common adapter for core and plugin providers. `JobRegistry` remains the only SQLite writer.

## Contracts

`acquisition/contracts.mjs` defines the runtime vocabulary and JSDoc shapes:

- `AcquisitionResult<T>`: `{ ok, data, attempts, warnings, error }`.
- `AcquisitionError`: stable code, provider ID, retryability, safe message, and optional retry delay.
- `Provenance`: provider, run, timestamp, source/canonical URL, external ID, content hash, extraction method, endpoint, and adapter/provider versions when known.
- `Evidence<T>`: field value, confidence, extraction method, and provenance.
- `RawJobPosting`: compatible provider job enriched by the common adapter.
- `NormalizedJobObservation`: registry-ready observation produced outside providers.
- `PageReader`: source-neutral public-page reader returning an `AcquisitionResult<PageContent>`.

Direct provider fields use `high` confidence only when present in the provider payload or explicit tracked target. The adapter labels parsing and normalization explicitly; it does not infer missing location, company, or identity claims.

Semantic errors include `AUTH_REQUIRED`, `RATE_LIMITED`, `BLOCKED`, `CAPTCHA`, `CHALLENGE`, `EMPTY_CONTENT`, `NOT_JOB_CONTENT`, `NOT_FOUND`, `SCHEMA_CHANGED`, `TIMEOUT`, `UPSTREAM_UNAVAILABLE`, and `POLICY_DENIED`.

## Provider migration

All dynamically loaded providers pass through `acquireProvider()`. Greenhouse, Lever, Ashby, Himalayas, RemoteOK, Remotive, and Working Nomads now declare adapter version `1`; their exposed provider-native IDs are retained. Browser Discovery exposes equivalent `browser:linkedin`, `browser:indeed`, and `browser:occ` providers and returns the same AcquisitionResult and RawJobPosting contracts. Greenhouse, Lever, and Ashby reject malformed top-level payloads as `SCHEMA_CHANGED` instead of silently treating them as empty boards.

Provider-specific parsing stays inside each provider. The common adapter handles URL canonicalization, content hashing, provenance/evidence construction, invalid-row warnings, and semantic error conversion. Providers never receive a registry handle.

## PageReader and public web fallback

`DirectPageReader` reads the original public URL through the scanner's guarded HTTP context. `JinaPageReader` reads the same URL through the fixed `https://r.jina.ai` endpoint. `PublicWebReader` always tries direct HTTP first and only calls Jina after a retryable or semantic content failure. Jina is never a primary discovery source.

The fallback is disabled by default. Enable it explicitly in `portals.yml`:

```yaml
acquisition:
  public_web_fallback:
    enabled: true
    jina: true
    max_pages_per_target: 1
```

The per-target limit defaults to `1` and is capped at `5`. Selection follows provider result order, keeping the same input deterministic even though providers run concurrently. Only jobs whose provider result lacks a description are read. `jina: false` enables direct reading without the third-party fallback.

No API key is read or sent. Using Jina sends the public job URL to a third-party service; its endpoint, adapter version, timestamp, and attempt result are stored in observation metadata. There is no cookie, authenticated session, browser profile, or browser reader.

## Content validation

HTTP success and content success are separate. `validateContent()` classifies `VALID`, `EMPTY_CONTENT`, `CAPTCHA`, `BLOCKED`, `LOGIN_REQUIRED`, `CHALLENGE`, `NOT_JOB_CONTENT`, `NOT_FOUND`, and `SCHEMA_CHANGED`.

An invalid direct response is not stored as a job description. If Jina is enabled, it becomes the second recorded attempt; otherwise the failure is attached to the run and the original provider observation remains available without invented content.

## Security and limits

- PageReader accepts only HTTP(S), credential-free public targets and rejects common loopback/private literal hosts.
- The existing guarded HTTP context and `redirect: error` remain in force.
- External page reading is opt-in and bounded; ordinary `node scan.mjs` and `npm run daily` behavior stays provider-only.
- No live Jina call is part of normal tests. All fallback tests use injected responses.
- Browser Discovery is a separate, explicitly invoked read-only source. It reuses the Jorge-profile and lock policy, caps each task, and has no place in the automatic daily loop.
