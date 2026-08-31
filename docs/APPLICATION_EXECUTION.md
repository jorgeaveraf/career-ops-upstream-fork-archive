# Application Execution (V2D)

Application execution is an explicit, job-scoped lifecycle. Career Ops may act only when the exact job has a valid `APPROVE_TO_APPLY` human action and the latest evaluation, package, plan, evidence, and artifacts still pass validation.

The lifecycle is:

`APPROVED_TO_APPLY` → `EXECUTING` → `APPLIED`

Execution may instead stop as `NEEDS_HUMAN`, `PARTIALLY_APPLIED`, `FAILED`, or `CANCELLED`. A challenge, expired authentication, CAPTCHA, unknown required question, or missing canonical answer stops the run without guessing. A run becomes `APPLIED` only when the channel returns durable confirmation evidence such as an application ID, confirmation URL, or email message ID.

The planner supports ATS, email, platform, and manual-external routes. The production ATS adapter uses a separate `application.submit` capability tied to the exact authorization, job, target origin, package version, plan hash, and expiry. Browser Research remains `research_only`. The adapter recognizes bounded structured forms, fills only canonical profile values, uploads only approved artifacts, stops on challenges or unknown required questions, and accepts success only from a visible confirmation state. A runtime without a configured adapter stops as `NEEDS_HUMAN` and does not submit. Artifacts are checked against the authorized hashes immediately before use. Replaying an already-confirmed authorization is idempotent.

Only one primary application is authorized per bounded run. An optional secondary outreach is allowed only when the plan explicitly permits it, and it is capped at one channel. There is no mass-apply path.

Use:

```bash
npm run application:execute -- status
npm run application:execute -- execute --authorization <authorization-id>
```

Sheet approval is imported through the Human Control Plane. `Applied Date`, execution status, and confirmation are Career Ops-owned fields; humans control `Application Decision`, `Outcome`, `Next Action`, and `Notes`.
