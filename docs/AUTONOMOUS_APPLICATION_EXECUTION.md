# Autonomous Application Execution

V4.3.3 turns an exact `APPROVE_TO_APPLY` decision into execution. The approval is bound to one job, plan hash, package ID/version, and application URL. It never authorizes outreach.

## Executor hierarchy

1. Use the native adapter when a supported ATS or transport can complete the exact plan.
2. If the native route is unsupported, use the Generic Browser Executor in the managed Chrome profile `Jorge`.
3. Stop for a human only at a real fact, security, or platform boundary. A missing specialized adapter is not a manual-application reason.

The Generic Browser Executor follows visible application CTAs and ordinary HTTPS redirects, including application destinations exposed behind an approved page's closed-shadow CTA, models each form step semantically, fills only resolved values, uploads the exact package artifacts, and advances until the final submit control. It does not depend on portal-specific CSS selectors. Radio and checkbox groups are modeled by their full question plus the complete visible option set, rather than by an individual option label.

## Semantic form resolution

Fields are classified as identity, contact, location, work authorization, sponsorship, application fact, resume, cover letter, account credential, or unresolved application question. Resolution precedence is:

1. exact job-scoped human answer;
2. exact Candidate KB fact;
3. exact package artifact from the enrichment manifest;
4. exact application-plan answer;
5. verified reusable answer.

Required unknown facts become `REAL_HUMAN_FACT_REQUIRED` with one precise question. The executor never guesses. File inputs accept only an existing manifest path whose current hash matches the stored artifact hash.

## Platform accounts and verification

Required platform accounts use `fubifo@gmail.com`. Candidate application and outreach email remains `jorgeaveraf@gmail.com`; the sign-up identity is never used as a sender.

Generated passwords are high-entropy and stored in macOS Keychain under a platform-specific service. SQLite, logs, Sheets, notifications, and reports contain only a `keychain://` reference. Existing active accounts are reused.

Ordinary verification is correlated by platform, recipient, request time, and execution ID. The bounded browser reader opens the authorized fubifo mailbox in the same Career Ops-owned Chrome session and selects one matching message. It can follow one ordinary verification link or enter one unambiguous short activation code into the originating platform form, and stores only hashed/sanitized evidence. A missing mailbox session, ambiguous links or codes, MFA, CAPTCHA, or uncertain completion fails closed.

## Security boundaries

`CAPTCHA_REQUIRED`, `MFA_REQUIRED`, `LOGIN_REAUTH_REQUIRED`, `SECURITY_CHALLENGE`, and genuine `PLATFORM_RESTRICTION` are external security boundaries. Career Ops records the exact URL/category, stops that job, and continues the rest of the batch. It never attempts bypass, token collection, or credential entry through the Sheet.

## Exact-once submit and confirmation

Before the final click, Career Ops persists `submit_intent_recorded` and `SUBMIT_INTENT_RECORDED`. After the click it persists `submit_attempted` and `SUBMIT_ATTEMPTED`. Success requires an observable confirmation page, provider/application ID, portal history, or a correlated confirmation email. Only then does the execution become `APPLIED`.

If a click may have occurred but confirmation is missing, the terminal state is `VERIFICATION_UNKNOWN`; automatic retry is forbidden. A failed execution may resume under the same exact authorization only when its mutation state is still `PRE_SUBMIT` and the failure is a recognized recoverable technical condition.

## Lifecycle and batch closure

Confirmed jobs are marked `ACTED`, leave `TODAY`, enter `APPLICATIONS`, and retain application URL/channel, executor mode, package version, artifact links, confirmation, contact, outreach, response, interview, next-action, and outcome context. The same bounded iteration then refills and reranks `TODAY`, continues already authorized outreach, projects the live Sheet, and creates one consolidated application-batch digest. Per-application success/failure mail is suppressed; a submit ambiguity remains an immediate safety exception.

The operational health surface exposes the native Application Executor, Generic Browser Executor, Keychain credential store, fubifo verification path, Candidate Gmail, LinkedIn browser, workers, Workspace authentication, and Google Sheets independently.
