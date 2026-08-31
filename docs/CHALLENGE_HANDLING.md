# Application challenge handling

Career Ops classifies application-page security state through one shared `ApplicationChallengeResolver` used by generic, Indeed, LinkedIn, and ATS flows.

## Taxonomy

- `NO_CHALLENGE`: the form is available and normal execution continues.
- `PASSIVE_CHALLENGE`: protection UI or reCAPTCHA text is present, but no visible user interaction is requested.
- `INTERACTIVE_CAPTCHA`: a visible checkbox, puzzle, text input, or explicit interactive control requires the candidate.
- `MFA_REQUIRED`, `LOGIN_REAUTH_REQUIRED`, and `SECURITY_CHALLENGE`: a precise sensitive action is required.
- `TECHNICAL_CHALLENGE_TIMEOUT`: a passive state did not resolve within the bounded window and no interactive challenge was observed.

## Passive wait

Passive verification is ordinary navigation behavior, not CAPTCHA bypass. The default policy waits 5 seconds, reinspects, waits another 5 seconds, and permits one final 5-second observation, capped by `APPLICATION_PASSIVE_CHALLENGE_MAX_MS` (20 seconds by default). `APPLICATION_PASSIVE_CHALLENGE_WAITS_MS` configures the intervals.

Progress includes navigation, disappearance of challenge UI, appearance or enablement of Continue/Submit, or a form becoming interactable. reCAPTCHA footer text on an already usable form is immediately `NO_CHALLENGE`. After resolution the executor continues the exact tab; it does not renavigate unnecessarily.

If time expires, Career Ops reclassifies from observable UI. A real interactive widget creates the existing resumable CAPTCHA handoff. A blank frame, network error, broken page, or unresolved passive loader becomes technical recovery. Waiting never invokes an anti-CAPTCHA service, simulates challenge solving, or bypasses MFA.

Passive waits create no human attention and no email. TODAY remains `WORKING / Waiting on Career Ops`; only confirmed interaction becomes `WAITING_FOR_YOU / Solve CAPTCHA`.
