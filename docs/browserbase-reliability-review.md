# Browserbase application reliability review

Reviewed 2026-11-02 against deployed application source
`dpl_8xeD7yDmu2q32cd4vcmotntK6xuu`, with the user request and
`docs/application-browser.md` as the behavior contract. The audit covers the
current browser/session, form observation and submission flow, including its
uncommitted application changes; unrelated catalogue and Telegram work is outside
scope. The standards and behavior reviews ran independently before fixes.

## Standards

| Confirmed gap | Consequence | Fix and regression evidence |
| --- | --- | --- |
| Final frame check used cached frames | A newly attached iframe could add required questions after approval without detection | Compare current visible frame identities/order; reject attachment, detachment and visibility changes. `application-computer-frames.test.ts` |
| Final check skipped frames without controls | An unchanged informational iframe made its own notices appear changed, forcing repeated review | Observe notices from the same complete visible frame set in both checks. Visible frames beyond the supported bound now fail explicitly |
| Cleanup awaited each close serially | An unresponsive Stagehand close prevented explicit provider release and task completion | Independent cleanup attempts, each bounded to five seconds; tests cover stuck closes, stuck release and preservation of callback results/errors. `application-browser-session.test.ts` |

The frame fix also requires combobox options to resolve in the validated observed
frame rather than indexing the browser's raw frame list. A hidden analytics frame
before the question frame is covered by a regression.

## Spec

| Confirmed gap | Contract affected | Fix and regression evidence |
| --- | --- | --- |
| The final gate compared structure but omitted current values and validity | Fill and send only approved answers | Revalidate answers, consent and validity after the asynchronous database gate, before the click. Three late-mutation regressions require zero submits. `application-computer.test.ts` |
| Individually wrapped choice labels overrode their shared question | Ground every question in observed employer text | Infer named radio/checkbox groups from their shared container without absorbing separate consent. Generated Chrome DOM regression: `scripts/verify/verify-computer-document.mts` |
| Receipt observation happened as soon as the old questions disappeared | Confirm employer receipt before calling a submission successful | Observe a bounded settling window before the single reserved receipt-model call. Two-second success, permanently busy page, unfamiliar stable page and late challenge regressions. `application-receipt-settling.test.ts` |

Each original failure was reproduced before its fix. Test fixtures use generated
data, and no real employer application is used to exercise sending. An ambiguous
or timed-out receipt remains `submission_unknown`; retrying a possibly completed
send is prohibited.

Standards: three resolved findings; the highest-impact gap was missing newly
attached frame questions. Spec: three resolved findings; the highest-impact gap
was sending changed answers after approval.

## Verification and release

Released as `dpl_22dEWRYnURVTayvQVKXnkGPH4BEW` on 2026-11-02. The production
alias was checked against that deployment. The release changes only the three
browser runtime files, preserving the previous live source for everything else.

- All 405 tests passed; the final focused browser suite passed 70 tests.
- ESLint, TypeScript and production build checks passed.
- The generated Chrome DOM check passed for wrapped radio/checkbox groups and
  separate consent.
- The actual-model complex local test passed conditional questions, dropdowns,
  multiple steps, approved PDF upload and leaving optional consent unchecked.
- The hosted Browserbase synthetic workflow persisted an employer-harness receipt
  at `2026-11-02T09:51:29.560Z`. The receiver recorded exactly one submission.
  Missing/stale approvals, cross-account access and duplicate approval were denied.
  Both generated accounts were deleted. No real application was resent.

Hosted acceptance establishes provider integration with a generated employer;
the fault-specific regressions establish the additional failure handling. Neither
is evidence that every real employer will complete automatically.

## Limits and provider checks

This strengthens the current implementation; it does not establish universal
support for arbitrary employer forms. Earlier login challenges still pause before
sending. Sessions remain isolated and disposable, without retained login contexts
or cross-worker reconnect. No CAPTCHA-solving or logging setting was changed.

Unfamiliar receipt pages use a 2.5-second text stability check; visible processing
or empty pages get up to 20 seconds. Employer delays outside those windows can
still require manual reconciliation. A failed provider release attempt is bounded
by the existing session timeout, rather than assumed successful.

Provider lifecycle behavior was checked against the installed Stagehand 4.3 code
and the official [Stagehand browser lifecycle](https://docs.stagehand.dev/v4/configuration/browser),
[Browserbase session timeout](https://docs.browserbase.com/platform/browser/long-sessions/timeouts)
and [Live View URL API](https://docs.browserbase.com/reference/api/session-live-urls)
documentation. These sources describe provider capabilities; the application
continues to own approval, receipt evidence, ownership and duplicate-send guards.
