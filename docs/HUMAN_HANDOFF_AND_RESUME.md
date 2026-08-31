# Human handoff and automatic resume

Career Ops owns an approved application from the first platform action through observable confirmation. A human boundary does not transfer ownership of the application. It creates one durable `HumanHandoff`, pauses the execution as `PAUSED_FOR_HUMAN`, and delegates only the smallest action that cannot be automated safely.

Supported handoffs are CAPTCHA, MFA, login/reauthentication, security challenge, real human facts, legal attestation, and platform confirmation. TODAY shows the friendly action, exact instruction, prepared application link, complete question bundle, and application progress. Internal codes do not appear in notification copy.

## Browser handoffs

The managed Jorge Chrome window remains open. Career Ops stores the exact window ID, tab ID, private marker URL, current URL, page signature, progress, and mutation state, then releases the worker lock without closing the window. The resume detector periodically reacquires the lock and adopts the window only after verifying its marker and target tab. CAPTCHA, MFA, login, and security completion are detected from the page state; Sync Jobs is not required. If a pre-submit window disappears, Career Ops may safely reconstruct the application up to the same boundary. It never reconstructs or retries an ambiguous post-submit state.

The candidate should perform only the requested micro-action and leave the tab open. Career Ops fills the form, uploads the exact approved artifacts, navigates the remaining steps, submits once, verifies confirmation, updates APPLICATIONS, and continues any separately authorized outreach.

## Human fact handoffs

Career Ops collects every unresolved question visible in the application into one bundle. The candidate enters all answers in the single yellow `Human Answer` cell and uses Sync Jobs once. The bundle is validated as a whole before any answer is accepted. Reusable facts such as English level, Python experience, and AWS experience enter the candidate knowledge base; compensation stays job-specific; legal attestations are not reused.

## Batch and notification behavior

One application batch can contain confirmed applications and several handoffs. The candidate receives at most one consolidated handoff email for the batch, plus an optional final completion email when the batch later reaches a terminal result. Background retries, unchanged CAPTCHA checks, worker wakes, and technical diagnostics remain silent. SETTINGS reports application automation, handoff readiness, and the active assist count.

Manual application takeover is not part of the normal product boundary. If a site presents an explicit restriction, Career Ops asks only for the specific confirmation needed or closes safely; it does not tell the candidate to finish the application manually.
