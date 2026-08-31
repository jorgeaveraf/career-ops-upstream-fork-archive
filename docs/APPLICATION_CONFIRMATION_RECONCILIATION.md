# Application confirmation reconciliation

Career Ops closes an approved application as soon as it has unambiguous, observable confirmation. The submitting worker remains the fast path: a success page or provider application ID transitions the execution immediately. The five-minute operational watcher is the safety net; it rechecks preserved execution/browser evidence and bounded recent Gmail metadata without attempting another submit.

Accepted strong evidence is an execution-bound success page, an application-provider ID, exact portal/application history, or a confirmation email. Gmail correlation requires a known recipient, a bounded execution-time window, confirmation language, and an exact company or role match. Similar or generic mail is ignored.

`ApplicationConfirmationReconciler` records `APPLICATION_CONFIRMATION_OBSERVED`, the canonical `APPLICATION_CONFIRMED` transition, and `APPLICATION_MOVED_TO_APPLICATIONS`. Stable evidence keys and the terminal APPLIED guard make browser-plus-email, watcher restart, and repeated Gmail reads idempotent.

The transition marks the candidate acted, removes it from TODAY through membership projection, upserts one APPLICATIONS row by job identity, preserves package/contact/outreach context, creates policy-driven follow-up projection, refills TODAY, reranks, and projects once. Reconciliation is normal lifecycle repair and intentionally sends no standalone email.

The expected healthy SLA is immediate for worker-observed confirmation and at most five minutes for the watcher/Gmail safety net.
