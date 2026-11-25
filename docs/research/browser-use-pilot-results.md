# Browser Use on Browserbase: fill-only pilot

Date: 2026-11-04. Isolated Python experiment; production controller unchanged.

## Configuration

- Browser Use 0.13.14, Python 3.12, Playwright 1.64.1.
- Browserbase cloud browser in `ap-southeast-1`, fresh sessions.
- Existing configured model: `alibaba/qwen3.7-flash` through Vercel AI Gateway.
- Browser Use owns observations, planning, native interaction, and retries.
- A narrow Playwright upload adapter sends only approved file bytes; Browser Use's
  default upload action expects paths on the remote browser machine.
- A separate Playwright observer checks committed values. Agent completion claims
  do not determine whether the form is filled.
- Submit events/clicks, native form submission methods, and all network writes are
  blocked. Guards are exercised against fictional data before the agent starts.

## Observed results

| Run | Independent form state | Agent behavior | Duration |
| --- | --- | --- | --- |
| Initial fixture | All 7 checks passed after repairing the fixture during execution | Eventually reported completion | 266 seconds; excluded as a clean benchmark |
| Fresh corrected fixture | All 7 checks passed without observer fills | Repeatedly mistook the cleared city search input for an uncommitted selection; operator stopped it after independent readback | 195 seconds, 13 steps |

The seven checks were name, email, dialing country, phone number, committed city,
eligibility selection, and file presence in an iframe. The city picker delays its
options and clears the search input after committing the selection. No network
writes occurred during filling. Both Browserbase sessions were explicitly released.

The initial fixture accidentally attached its click handler to a dropdown element
injected by Browserbase. Scoping the fixture handler to its own list fixed this;
that failure is not attributed to Browser Use. The initial run also encountered a
model action-schema error and recovered. The clean run's city value was actually
committed even while the agent continued attempting to repair it.

## Implication

Browser Use can operate this representative form, but replacing the controller
alone does not establish reliable completion. Keep an independent field-state
validator and stop the agent when its postconditions pass. A cleared combobox
search input must not outweigh a committed selection. Evaluate actual employer
forms before choosing it as the production controller.

## Actual Prenuvo result

The user explicitly authorized the saved candidate facts and screenshots going to
Vercel AI Gateway / the configured Qwen model, then expanded the test to actual
submission and CAPTCHA handling.

- Browser Use reported success with 13 of 14 required fields verified. City was
  empty. Independent feedback recovered the city selection.
- Editing the approved cover letter left partial text and eventually timed out.
  This is not a successful standalone Browser Use completion.
- The final application used deterministic recovery of the same approved answers.
  All 14 required fields, the exact cover letter, and résumé acknowledgement were
  verified. The résumé S3 upload returned HTTP 201. Three contact values needed
  restoration after upload before the final check passed.
- A first Submit click was blocked locally because the test allowlist omitted
  Greenhouse's legacy submission host. No application POST was forwarded in that
  attempt. The exact observed endpoint was then allowed and the pending intent
  continued after re-verification.
- Exactly one application POST was forwarded to
  `boards.greenhouse.io/embed/prenuvo/jobs/4742463005`. It returned HTTP 428 with
  `code: captcha-failed`. The form requested an 8-character code emailed to the
  candidate's saved Outlook address. No successful employer receipt appeared.
- The first browser was released after its bounded verification wait. Its
  application record was set to `submission_unknown` without a receipt to prevent
  automatic retries. The later, explicitly authorized Telegram continuation is
  documented below.

Trial harness issues were distinguished from agent behavior: automatic URL opening
was disabled after it selected a supplied profile URL; a resumed run initially
used an incorrect absolute step limit; the upload allowlist was narrowed to the
observed S3 endpoint; and the submission allowlist was corrected to the observed
legacy host. These are not evidence of Browser Use library defects.

The conclusion is limited: this Browser Use/Qwen combination still needed explicit
postcondition checks and recovery. The standalone agent did not complete the full flow. The later deterministic
recovery and Telegram relay did confirm submission. Production was not switched
to Browser Use.

## Telegram continuation: confirmed submission

The user explicitly requested collection of the email code through Telegram and
completion of submission. The previous HTTP 428 `captcha-failed` response proved
employer rejection before reopening the form. The new session independently
verified all 14 required fields, exact approved cover letter, and résumé upload.
Its initial POST also returned HTTP 428 and displayed eight code boxes.

The production verification adapter now supports segmented code inputs, including
a code-only fieldset inside an application form. An external Submit application
control is available only during an already-authorized submission. The adapter
checks the surface before every character and binds the continuation to unchanged
application values. The existing Telegram inbox checks owner, revision, session,
reply message, expiration, and one-time consumption; queued codes are encrypted.

The live prompt reached the linked Telegram account. The user's reply was consumed
and filled all eight boxes. The pilot's 45-second network permit expired during
verification and locally blocked the continuation. The still-unconsumed permit
and unchanged HTTP 428 response established that this request had not reached the
employer. Renewing that permit for the exact same Telegram-authorized code allowed
the existing form continuation; no fresh unverified application was sent.

Greenhouse returned HTTP 200 and navigated to its confirmation page showing
“Your application has been received.” at 2026-11-04T16:15:32.945Z. The receipt was
persisted, the application status verified as `submitted`, and the Telegram task
verified as `completed` with its prompt metadata cleared. A confirmation was sent
through Telegram, and Browserbase confirmed session release.

Production deployment `dpl_EginegpXE5Wsn55E5BVFVSgEE8QZ` is READY and serves the
existing production alias. It changes only the two verification modules on top of
the then-current production source. Validation: 23 Telegram/assistance tests,
14 local browser fixture checks, TypeScript, ESLint, and production build passed.
The trial permit now lasts up to 120 seconds, bounded by the session deadline.
This demonstrates one completed Telegram-assisted application, not general
form-filling reliability or autonomous CAPTCHA solving.

## Artifacts and limitations

Driver and pinned dependencies: `scripts/browser-use-trial/`. Private screenshots,
logs, field-level evidence, and session metadata: `.local-data/browser-use-trial/`.
Neither candidate data nor credentials belong in tracked reports.

This is one synthetic layout, not a reliability percentage or an across-ATS result.
Its iframe is same-origin. The Prenuvo phase also exercised a real cross-origin Greenhouse frame.
The final résumé upload returned HTTP 201. The final Telegram continuation confirmed submission. Earlier fill-only runs
deliberately blocked writes.

References: [Browserbase Browser Use integration](https://docs.browserbase.com/integrations/browseruse/python),
[Browser Use agent parameters](https://docs.browser-use.com/open-source/customize/agent/all-parameters).
