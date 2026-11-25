# Browserbase and job-portal reliability

Checked 2026-11-03 using Browserbase's official templates, current template source
through the GitHub connector, Stagehand v4 docs, Ashby docs, and this checkout.
This is a research assessment, not a successful employer application or a deployed
change. The project's installed Stagehand version is 4.3.0.

## Findings that change the diagnosis

The strongest finding is in Ashby's own documentation: an application-limit
**callout above the form** differs from the **message shown when an application is
actually blocked**. Ashby uses the entered email to check prior applications.
The notice alone does not establish that the candidate exceeded a limit.
The worker baseline's `/application limit/i` test treated any such notice as a
stop for every employer except its special n8n path. Changing Browserbase settings
cannot resolve that application-level decision. Do not change candidate identity to
evade a limit. [Ashby application limits](https://docs.ashbyhq.com/application-limits)

Inference for our flow: the previous local change improved error reporting and
stopped wasted browser work but retained the blanket policy block. A useful fix
must separate informational notices, known prior-application conflicts, unknown
outside history requiring candidate review, and an observed employer rejection.
It must preserve one-send and uncertain-result protections.

## What Browserbase actually provides

| Resource | Inspected behavior | Useful lesson and limit |
| --- | --- | --- |
| [Official job-application template](https://github.com/browserbase/templates/blob/dev/typescript/job-application/index.ts) | Stagehand v4 `act()` fills a generated agent ID/email and deployment region on `agent-job-board.vercel.app`; `observe()` locates a file input for direct upload; a final click is followed by a success log | Demonstrates primitives and concurrency, not verified Ashby/Greenhouse/Lever/Workday completion. It lacks our authoritative receipt check. |
| [Template README](https://github.com/browserbase/templates/blob/dev/typescript/job-application/README.md) | Lists multi-board field mappings, tracking, stronger retries and error reporting as next steps | The template is a starting point, not a production ATS connector. |
| [Exa application-review template](https://github.com/browserbase/templates/blob/dev/typescript/exa-browserbase/README.md) | Finds live careers pages, uses Stagehand `observe()` for controls, replays supplied values, uploads a resume, then extracts outstanding required questions; deliberately never submits | Closest reference for safe preparation. Action success and upload command completion are explicitly weaker than persisted employer values. The current source is more conservative than the landing page's automation description. |
| [Human-assistance template](https://github.com/browserbase/templates/blob/dev/typescript/agent-with-human-in-loop/lib/agent.ts) | AI SDK tools include `askHuman`; SSE carries a question, an awaited response resumes the same browser task, and Live View exposes the browser | Unknown required facts and consequential choices should become actionable questions rather than terminal generic failures. The template's session discovery and success reporting are demo shortcuts, not replacements for account ownership and receipts. |
| [Assistance session store](https://github.com/browserbase/templates/blob/dev/typescript/agent-with-human-in-loop/lib/session-store.ts) | In-memory map stores pending promises; source explicitly recommends a durable database in production | Reuse our Postgres run/revision model rather than copying the process-local map. |

The live assistance template now runs a commit-pinned `stagehand-codemode`
integration with a Stagehand 4.0 override. A cached web copy of its package file
still mentioned v3; the live GitHub connector returned the updated v4-based
source. The code-mode tool executes model-authored browser code, a broader
authority than our restricted approved-answer tools. Copy the interaction
pattern, not the unrestricted tool or package setup.
[Current template dependencies](https://github.com/browserbase/templates/blob/dev/typescript/agent-with-human-in-loop/package.json)

No inspected first-party resource established a production support matrix or
verified universal completion for the four ATS families. This is a limit of the
evidence reviewed, not a claim that no other solution exists.

## Where our implementation differs

The current default is our AI SDK screenshot/DOM planner in
`lib/server/applications/computer-agent.ts`. It identifies questions and asks
the backend to fill approved answers. `stagehand-actions.ts` uses Stagehand only
to execute exact approved actions; `browser-session.ts` disables self-healing and
caching. Consequently, Browserbase's native form observation and extraction are
not currently helping our question discovery.

Stagehand v4 `observe()` returns structured actions for inspection and validation;
`act(Action)` replays an action without another inference call. Its docs also
cover iframe and shadow-root traversal. These are concrete proposal sources to
benchmark against our custom planner, not authority to invent facts or weaken
the complete-question and final-value checks.
[Observe](https://docs.stagehand.dev/v4/basics/observe),
[Act](https://docs.stagehand.dev/v4/basics/act)

The provider's recommended speed pattern is one form observation followed by
deterministic action replay. Cache applies to Stagehand inference, not our
separate screenshot loop. Enabling cache or selector self-healing globally would
not repair our policy block or establish that a substituted target remains the
candidate's approved question.
[Speed guide](https://docs.stagehand.dev/v4/best-practices/speed-optimization),
[Caching](https://docs.stagehand.dev/v4/best-practices/caching)

Our combobox path already attempts an exact observed option, typing a supplied
answer to reveal search-backed results when necessary. It still needs an
ATS-shaped acceptance fixture proving asynchronous results, option selection,
blur/re-render persistence, and the actual selected value. An input merely
containing the location's text must not count as a committed selection. This is
a proposed test requirement, not a measured Stagehand advantage.

Browserbase Live View supports watch, click, type and scroll in an active session.
Our current handoff is focused on final checks and receipt verification. The
useful extension is the same bounded owner-only help for a pre-submit control the
runner cannot complete, followed by re-observation and value validation; restarting
the entire application is not equivalent to continuing that browser.
[Live View](https://docs.browserbase.com/platform/browser/observability/session-live-view)

Resume upload already follows the documented Playwright `setInputFiles` approach;
there is no evidence that replacing it with a different upload service would fix
the observed policy failure.
[Browserbase uploads](https://docs.browserbase.com/platform/browser/files/uploads)

## Recommended changes and verification

1. Replace the blanket notice stop with policy review bound to the current
   application revision and notice text. Check known submitted/active/uncertain
   employer history. Ask the candidate about relevant outside history when the
   app cannot establish it; do not guess eligibility or treat a notice as a
   rejection. Changed policy invalidates the earlier review.
2. Keep exact approved-value filling. Benchmark a bounded Stagehand v4
   observe/extract proposal path for failed discovery or dynamic widgets against
   the current planner on the same generated forms. A proposal must resolve to
   a current observed element and preserve required questions and option sets.
3. Extend same-session help to unsupported pre-submit interactions. Persist the
   question/control reason, revision, session identity and deadline; pause AI
   actions while the owner acts and validate the complete form afterward.
4. Preserve the existing backend final gate. The Stagehand approval cookbook
   explicitly binds approval to displayed values, verifies the confirmation
   destination and prevents repeat submissions; ambiguous attempts must be
   reconciled before restarting. [Approval cookbook](https://docs.stagehand.dev/v4/cookbooks/approve-form-submission)
5. Distinguish real employer rejection, validation errors, assistance needed,
   provider failure, and uncertain submission. Ashby's documented submission
   response includes `formMessages.blocked`; a normal same-browser response can
   corroborate outcome when available. HTTP success or a model completion claim
   alone is insufficient. Calling its documented API directly requires employer
   credentials and `candidatesWrite`, so it is not a universal applicant-side
   replacement. [Submit contract](https://developers.ashbyhq.com/reference/applicationformsubmit),
   [API authentication](https://developers.ashbyhq.com/reference/authentication)

Acceptance must include informational limit notice with no known conflict,
candidate-declared prior application, a known conflict, changed notice after
review, and an explicit employer block. Add dynamic location/search dropdown,
grouped checkbox/radio, conditional questions, resume upload, and multi-step
fixtures. Every case must assert exact answers/consent, one final click at most,
verified success or an honest bounded pause, and cleanup of the same browser.
Run actual-model Browserbase tests against generated data; record completion,
model turns, runtime and safe failure codes. A live public-form inspection without
typing or sending can validate discovery, but only a synthetic receiver should
exercise submission during diagnosis. Do not resend a real application to test
an uncertain outcome.

No new provider setting, package installation, model change, live employer send,
or deployment was performed for this research.

## Local follow-up implementation

The follow-up removes the blanket text match from the submission worker. Employer
notices stay in the packet; the existing known n8n cooldown and all approval,
required-answer, send-intent and receipt checks remain. Saved and newly observed
informational limit notices now reach the normal submission gate. This does not
add a general employer-policy parser or establish the candidate's outside
application history. The broader policy review and assisted-control work above
remain recommendations.

Before the correction, all three new notice regressions failed at the blanket
block. Afterward, the application suite passed 186 tests, including confirmed and
unconfirmed sends with the notice and a known cooldown that still stops before
opening a browser. ESLint, TypeScript and `git diff --check` passed. These are
local regression results, not a verified SandboxAQ submission or a deployed fix.

## Combined implementation and review

The follow-up implementation combines `f1d19f0` with read-only native form hints,
same-session field assistance, exact upload provenance and explicit blocked-receipt
handling. Claude's upload ordering, cover-letter handling, shared deadlines,
early authentication handoff and stale-run recovery remain in place. See the
[implementation and verification guide](../application-browser.md#reliability-changes-on-2026-11-03).

### Standards review

The review found that hidden model transport retries could exceed the reserved
attempt count. The merged agent retains zero transport retries; its regression
asserts one provider request for one quota reservation. Native hints also reserve
an attempt before inference and never execute proposed actions directly.

### Spec review

The review found that a selected-file marker did not establish approval, and
early human help could lose submission provenance. The merged code verifies
exactly one document's bytes and takes its final fresh answer snapshot after
hashing. It restricts early authentication writes to observed credential forms
and verified redirects, blocks application sending during field help, and fully
rereviews after assistance. Regressions cover replacement/additional files,
autofill during hashing, new GET forms and shared authentication endpoints.
Both focused review passes cleared these fixes.

The frozen release suite passed 511 tests, ESLint, TypeScript and diff whitespace
checks. The actual-model delayed-dropdown/conditional-question check passed with
one generated submission and optional consent untouched. The staged Browserbase
workflow stored a receipt at `2026-11-03T06:04:50.266Z`, verified exactly one
receiver submission, denied duplicate/stale approvals and cross-account access,
and deleted both generated accounts. Native Stagehand observation returned seven
form proposals in that run. Required migrations `202611030043` and `202611030044`
were applied together and verified in the isolated staging database's history.

A hosted field-help test exposed mapping errors alternating with failed fills,
which reset the earlier repeated-error counter until the worker deadline. The
release now counts actual failed fill attempts independently, ending after three
even when a mapping correction occurs between them. Its regression confirms
zero sends before the help decision. The separate, uncommitted account-queue
feature is preserved in the original workspace and is not part of this release;
its required migration has not been applied.

The final deployed Browserbase field-assistance acceptance passed at
`2026-11-03T06:32:24.943Z` on deployment
`dpl_7vr5oNxNx1YcYByUfp5PunTdnxYQ`. The owner-only Live View completed the
generated dropdown in the original session. The worker rereviewed the form and
the receiver verified its committed location identifier, approved answers,
untouched optional consent and PDF, then counted exactly one submission. Stale
approval and cross-account access were denied; both generated accounts were
deleted. An earlier manual attempt missed the bounded window and stopped before
send, confirming the expiry path. No real employer was contacted.
