# Application reliability review — 2026-11-08

Reviewed the application flow at `b858d43`: preparation, browser tools, form
questions, submission intent, receipts, task persistence, retries, recovery,
API revision checks, and Telegram continuation. README and the application
pipeline/browser guides supplied the behavior contract. This was a review of
the current flow, not just the previous iframe patch.

## Standards findings

Two browser correctness defects violated the evidence and single-send contract:

- **P1 — repeated final-submit clicks.** The Python worker recorded intent once
  but allowed subsequent clicks on the final submission control. A real SDK
  regression reproduced two native clicks. The worker now fences the original
  click before executing it, including when the click returns a navigation
  error. Subsequent verification controls remain available.
- **P1 — false receipt evidence.** Conditional instructions such as “Once your
  application is submitted…” could establish success. A hidden ancestor iframe
  could also supply supposedly visible receipt text. Receipt inspection now
  rejects conditional/question text, checks ancestor visibility, and rejects
  still-editable required controls in identifiable application forms. Real
  Chromium cases preserve valid confirmation text and required newsletter
  controls on receipt pages.

No stylistic refactoring was included.

## Spec findings

Two defects violated the pipeline's durable execution and revision contracts:

- **P1 — reads interrupted live workers.** Detail reads expired sending runs
  after ten minutes although the worker permits 770 seconds. A poll could
  invalidate the submission transition or reject a real receipt. Reads now
  use the scheduled recovery threshold of fifteen minutes; preparation retains
  its existing policy. Regression cases cover both running and submitting at
  eleven, fourteen and sixteen minutes.
- **P1 — stale preparation retry.** The HTTP request included a revision but
  ignored it when invoking the retry RPC. A stale request could restart a newer
  cancellation. The new RPC locks the owned row and checks its revision before
  invoking the existing retry logic. Owner, quota, receipt, send-history and
  automatic-continuation guards remain in force. The older function remains
  available for compatible callers including Telegram.

## Validation and release ordering

- 855 TypeScript tests passed, including real Chromium receipt cases.
- 18 Python worker tests passed against the installed pinned Browser Use SDK.
- 12 intercepted Chrome challenge/verification scenarios passed without real
  employer, solver or Telegram traffic.
- Typecheck, lint, production build and function-bundle validation passed.
- CI now installs Chromium, runs the browser verification scenario, and runs
  the Python worker tests in a separate job. These worker tests were previously
  absent from CI.

Migration `202611080062_revision_fenced_preparation_retry.sql` must precede the
HTTP route deployment. It was applied alone in a transaction to the verified
`job-search-staging` project used by the deployed application. Four unrelated
older migrations reported by the dry run were excluded. No historical
applications were retried or reclassified by this migration.

The first hosted synthetic check exposed a test-receiver mismatch: native
automatic applications supply saved identity separately from missing-question
answers. The receiver now validates absent identity questions against the
generated fixture's completed source checkpoint. Explicit answers still take
precedence; altered identity, missing source, and manual omission are rejected.
This changes only the synthetic receiver, not real employer submission logic.
The unsuccessful check remained unconfirmed and its generated accounts were
deleted; it is not counted as submission success.

## Remaining limits

The indexed native-click path now prevents a second original send. JavaScript
evaluation and keyboard tools still rely on agent instructions to avoid sending
forms; this review does not establish an enforceable boundary across every
possible browser action. Disabling those capabilities needs representative
form-control coverage to avoid breaking existing forms.

No software change resolves an earlier unconfirmed employer outcome. NTS and
the older 8th Light attempt still require independent outcome evidence or an
explicitly authorized retry. The review does not certify every historical
receipt, every employer website, or the absence of all regressions.
