# Authentication architecture

## Workspace control plane

- Principal: `brunova-knowledge-agent@brunova-ai-platform.iam.gserviceaccount.com`.
- Effective Workspace subject: `brunova@brunova.mx`.
- Provider: Cloud Run metadata identity → IAM `signBlob` → DWD → short-lived Sheets token.
- Local credential: an HMAC application secret stored in `.env` mode 0600 and in Secret Manager; no Google credential or private key.
- Bootstrap: one narrow IAM/DWD administrator setup. Ordinary starts and token renewal are non-interactive.
- Failure behavior: bounded fresh-token retries, Sheet verification, precise layer code, then one causal admin notification.

## Command receiver

Apps Script signs a command to the public command gateway. The gateway publishes to Pub/Sub. The same gateway, running as its dedicated service account, performs authenticated pull/ack for the local subscriber. The Mac therefore has no Pub/Sub ADC. Sheet projection can fail independently after a command is durably processed.

## Candidate Gmail

- Principal and sender: `jorgeaveraf@gmail.com`.
- Provider: isolated OAuth `authorized_user` refresh token in `data/auth/candidate-gmail/application_default_credentials.json`.
- Scopes: Gmail send/read plus identity scopes requested by the bootstrap helper.
- Bootstrap: one-time consent in Chrome profile Jorge.
- Runtime: refresh token → memory-only access token; Chrome need not remain logged in or open.
- Assertion: `users/me/profile` must exactly equal `jorgeaveraf@gmail.com`; mismatch fails closed.
- Consent status: External/In Production as **Career Ops Candidate Gmail**, with a post-publication credential issued to `jorgeaveraf@gmail.com`; the saved scopes are `openid`, `userinfo.email`, `gmail.send`, and `gmail.readonly`.
- Risk boundary: revocation, password/security events, client deletion, or Google account policy can invalidate this consumer credential and require explicit reauthorization. Google verification is still required to remove the unverified-app warning and external-user cap. The credential is never reused for Workspace.

## Browser and LinkedIn

- Logical profile: `Jorge`.
- Use: LinkedIn, ATS, job research, and explicitly authorized browser actions.
- It is not an authentication backend for Sheets, Pub/Sub, Workspace, Candidate Gmail API refresh, or system notifications.

## Other identities

- Platform signup: `fubifo@gmail.com`; prohibited as application/contact sender.
- System notification sender: `Career Ops <career@brunova.mx>` through Resend.

## Security boundaries

Production provider pinning fails startup if Workspace drifts to ADC or the command subscriber drifts to direct Pub/Sub. Secrets are gitignored and mode 0600. No access/refresh token is logged or written to reports. Server-grade identities generate short-lived tokens; Candidate Gmail remains a separate consumer OAuth lifecycle.
