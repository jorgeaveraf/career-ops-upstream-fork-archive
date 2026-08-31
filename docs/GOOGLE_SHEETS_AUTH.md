# Google Sheets headless authentication

Production is pinned to `workspace_broker`:

```text
Career Ops LaunchAgent
  -> HMAC-authenticated Workspace broker (Cloud Run)
  -> Cloud Run metadata identity
  -> IAM Credentials signBlob
  -> brunova-knowledge-agent service account
  -> Workspace Domain-Wide Delegation
  -> subject brunova@brunova.mx
  -> short-lived Sheets token
```

```dotenv
CAREER_OPS_PRODUCTION=true
GOOGLE_SHEETS_AUTH_MODE=workspace_broker
CAREER_OPS_WORKSPACE_BROKER_URL=https://your-broker.run.app
CAREER_OPS_WORKSPACE_BROKER_SECRET=managed-outside-git
GOOGLE_REMOTE_SIGNER_SERVICE_ACCOUNT=brunova-knowledge-agent@brunova-ai-platform.iam.gserviceaccount.com
GOOGLE_IMPERSONATION_SUBJECT=brunova@brunova.mx
GOOGLE_SHEETS_SCOPES=https://www.googleapis.com/auth/spreadsheets
```

The broker secret authenticates Career Ops to its narrow token service; it is not a Google user credential. Google access-token generation happens inside Cloud Run. The service uses no private service-account key. A fresh DWD token is generated after cache expiry and every forced health probe. Runtime does not read `~/.config/gcloud/application_default_credentials.json`, does not open Chrome, and is not exposed to RAPT.

The Cloud Run service account needs these narrow grants:

- Secret Accessor on `career-ops-workspace-broker-hmac`.
- Service Account Token Creator on itself for `signBlob`.
- Workspace DWD client authorization for the Sheets scope.

`application_default`, `oauth_env`, local `iam_remote_signing`, and private-key `service_account_impersonation` remain development/forensic compatibility modes. With `CAREER_OPS_PRODUCTION=true`, startup rejects them as provider drift. `npm run google:auth -- authorize` can bootstrap development ADC only when that development mode was explicitly selected; it never rewrites `.env` or the production provider.

Candidate Gmail is not part of this chain. It has its own isolated authorized-user credential under `data/auth/candidate-gmail/`, verifies `users/me/profile` as `jorgeaveraf@gmail.com`, and never supplies Sheets credentials.

Failures preserve their layer: `WORKSPACE_BROKER_UNAVAILABLE`, `BROKER_AUTH_INVALID`, `IAM_SIGNING_FAILED`, `DWD_TOKEN_EXCHANGE_FAILED`, `WORKSPACE_IDENTITY_MISMATCH`, and API-specific authorization errors. The watcher retries fresh token generation and a Sheet metadata read before escalating.
