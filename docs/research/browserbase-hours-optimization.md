# Reduce Browserbase hours in Job Search

Reviewed 2026-11-02 against current official Browserbase guides, Stagehand v4
guides, installed Stagehand 4.3.0 / SDK types, and the application runner. This
assessment makes no account, credential, browser-setting, or application change.
No live employer was used for measurement. Recommendations below are supported
by code inspection; their browser-hour savings have not yet been measured.

## Measure the right resource

| Resource | Meaning | What changes it |
| --- | --- | --- |
| Browser runtime/hours | Sum of the durations of all running browser sessions | Shorter sessions, fewer redundant sessions, prompt release |
| Billed browser minutes | Provider accounting after its minimums/rounding | Runtime plus session minimums; reconcile to production usage |
| Model tokens | Input/output tokens charged by the selected model provider | Fewer model calls, smaller context/images, suitable models |
| Proxy bandwidth | Traffic passing through a proxy | Proxy routing and loaded resources; not equivalent to browser time |
| End-to-end wall time | How long the candidate waits | Parallelism can reduce this without reducing summed browser hours |
| Concurrency | Number of sessions running simultaneously | Throughput/capacity; more concurrency is not an hours discount |

Browserbase's plans guide says browser time uses minute rounding with a one-minute
minimum per session; the cost guide also states the session minimum. Faster code
can reduce active runtime without changing billed minutes until a billing increment
is crossed. Preserve both metrics rather than claiming each millisecond saved is
an invoice reduction.
[Plans and minimums](https://docs.browserbase.com/account/billing/plans),
[session cost optimization](https://docs.browserbase.com/optimizations/cost/cost-optimization)

**Documentation caveat:** the cost guide describes Functions as billing actual
execution time without minimum-runtime waste, whereas the general plans page
describes rounded browser minutes. Functions are a different lifecycle, not proof
our current direct sessions have per-second billing. Their limits page says the
browser closes at terminal invocation state, keepAlive is unsupported, and the
runtime is fixed to `us-west-2`. Do not migrate or promise a billing reduction
without confirming the production meter and a generated acceptance comparison.
[Functions limits](https://docs.browserbase.com/platform/functions/limits)

## Highest-priority opportunities in this runner

The priority is expected relevance, not a measured ranking. Exact percentages are
unknown until production session/phase durations are recorded.

| Priority | Actual code evidence | Change to evaluate | Saving to measure |
| --- | --- | --- | --- |
| 1 | `sendApplication` fetches profile and auth identity sequentially inside `withEmployerBrowser` | Load both before creating the paid browser, using independent parallel reads | DB/auth waiting removed from session runtime |
| 1 | Receipt settling repeatedly calls full `ComputerBrowser.observe()`; each call captures JPEG after scanning frames | Poll lightweight DOM readiness/challenge state; capture one fresh screenshot for the actual model decision | Avoided screenshot/CDP time during settling |
| 1 | Every exact fill/click reads a frame's full control document; the action adapter creates/detaches CDP and lists Stagehand pages each time | Reuse session/page transport handles; batch safe read-only checks at a reviewed epoch | Fewer control-plane round trips per field |
| 2 | No explicit `region` passed to Browserbase launch | Benchmark provider region near the actual deployed worker | Reduced RTT multiplied across actions/observations |
| 2 | Every review invokes saved-answer lookup and answer resolution while the browser is alive | Cache only stable account/revision-scoped answer-memory reads; skip repeat resolution for unchanged fields | Repeated DB/model waits removed from the active session |
| 2 | Every fill regenerates `resumeFile(packet.resume)` for the upload | Prepare one PDF buffer for the approved resume, outside the browser callback where practical | CPU generation time and repeated upload work avoided |
| 2 | Recovery can replay all fields after partial failure | Track validated completed values and avoid unchanged fills, while rechecking changed/conditional controls | Repeated uploads/fills and subsequent settling avoided |
| 3 | Preparation and sending use separate sessions | Consider reuse only for an immediate, same-account/same-application uninterrupted phase | Startup/revisit/minimum costs, offset by any idle time |
| 3 | User assistance keeps a browser alive up to three minutes | Instrument assistance time separately; keep it only when a same-session challenge needs it | Waiting cost made visible; expiry prevents indefinite idle usage |

The preparation flow already closes discovery before resume tailoring and packet
answer generation. Keep that useful separation: a browser should not sit idle
while AI writes a resume. Moving all preparation into one long-lived session
would undo it. Likewise, don't overlap browser startup with unrelated AI/DB work
solely to improve perceived latency: early launch can increase paid active time.

### Control-plane round trips are a strong first target

`ComputerBrowser.locator()` calls `frame.evaluate(readComputerDocument)` to
revalidate a control. `performBrowserAction()` then checks counts/handles, marks
the target and ancestor frames, creates a CDP session, requests target metadata,
lists Stagehand pages, validates again, executes the exact action, detaches CDP,
and removes markers. These are safety checks, but repeating transport/page
discovery per field is independent of whether the candidate's answer is safe.

Concentrate optimizations at that seam: session-local stable page/CDP handles,
and fewer batched read-only observations, with invalidation on page/frame changes.
Do not cache arbitrary stale locators or run field mutations concurrently; a fill
can reveal questions or rebuild the DOM needed by the next action. Before/after
must still deny stale targets, cross-frame mistakes, changed options, unapproved
defaults, and altered values near the final submit action.

Browserbase explicitly notes that small interactions can generate multiple CDP
commands and recommends placing browser and code geographically close.
[Browser performance guide](https://docs.browserbase.com/optimizations/latency/speed-optimization)

### Screenshot efficiency without losing proof

Current `observe()` scans visible frame DOMs and captures JPEG at quality 65.
The receipt settling loop can call it every 250 ms; assistance readiness checks
also call it while the candidate works. Those polls need to detect challenge,
loading, stable text, and changed controls; they don't all need a model image.
Separate screenshot capture from a complete DOM/security observation and take a
fresh image immediately before a model consumes it. Do not reuse an image across
an actual action/change or omit the final receipt image merely to save bytes.

A smaller image directly reduces transfer/model payload, but only reduces browser
hours if the full task ends sooner. Lower image fidelity that causes more model
mistakes can increase runtime. Record screenshot count and duration as well as
model turns and success rate.

### Region selection is a measured choice

Official API guidance lists `us-west-2`, `us-east-1`, `eu-central-1`, and
`ap-southeast-1`, with `us-west-2` the default. The repo's `vercel.json` says
`icn1`, while earlier runtime evidence in this session used `iad1`; do not infer
the active worker location from a file alone. Benchmark from the actual deployed
worker, keeping employer/site geography and access behavior constant. The guide's
published speed-up claim is not a measured result for this application.
[Browser regions](https://docs.browserbase.com/optimizations/latency/multi-region)

## Stagehand caching is not the missing hours switch

Current `stagehand.act()` receives an exact `Action` with backend-approved
selector/method/arguments, and self-healing is disabled. Official v4 docs say this
path executes without new model inference. Enabling caching does not remove model
calls that this action path already doesn't make. Our selectors are also marked
with a fresh UUID per action, which is unsuitable for blindly replaying a cached
target in another browser.
[v4 Act behavior](https://docs.stagehand.dev/v4/basics/act)

Managed caching applies to eligible Stagehand act/observe/extract inference and
can reduce token usage and associated waiting. Our separate AI SDK screenshot
loop is not automatically cached by toggling `Stagehand.create({ cache: true })`.
Evaluate caching if we introduce native observe/extract, keyed to suitable public
page data and validated against current controls. Keep personal answers and final
submission out of shared cached decisions.
[Caching guide](https://docs.stagehand.dev/v4/best-practices/caching)

The speed guide recommends one observation followed by deterministic action
replay. The existing app already groups approved fills into one tool call, so a
replacement must beat the current whole flow, not an imaginary one-model-call-per-
field baseline. Scoped observation can help with noisy pages, but never remove a
potential required question merely because it is expensive to inspect.
[v4 speed guide](https://docs.stagehand.dev/v4/best-practices/speed-optimization)

Model selection affects token cost and inference latency separately. A cheaper
but slower/less accurate model can use more browser hours through repeated
reviews. Compare successful completion, turns, model time, tokens, and browser
runtime on the same generated forms. Any model escalation should happen during
side-effect-free planning, never by replaying an uncertain submit.
[v4 cost guide](https://docs.stagehand.dev/v4/best-practices/cost-optimization)

## Avoid false savings

- **KeepAlive is not pause billing.** It preserves the browser after disconnect
  and continues until release/timeout. It can avoid minimum charges for adjacent
  sub-minute jobs, but leaving it idle while awaiting a Telegram answer can cost
  more than a fresh session. Do not pool browsers across applicants or employer
  logins. [Keep alive](https://docs.browserbase.com/platform/browser/long-sessions/keep-alive)
- **Timeout is a ceiling, not a normal session length.** The current 600-second
  timeout protects against orphans. Lowering it helps only if it catches wasted
  tails earlier; too short can interrupt a valid post-click receipt and force an
  uncertain result. Retain phase budgets and immediate cleanup instead of relying
  on the ceiling. [Timeouts](https://docs.browserbase.com/platform/browser/long-sessions/timeouts)
- **Cleanup must actually release.** Current code independently bounds its close
  operations and calls `REQUEST_RELEASE`; this is already a useful improvement.
  Reconcile final provider status asynchronously so a failed release does not stay
  invisible until timeout. [Update session](https://docs.browserbase.com/reference/api/update-a-session)
- **Parallel sessions save waiting, not necessarily hours.** Summed session time
  remains the consumption baseline; contention can make it worse. Parallelize
  independent DB/auth reads outside the browser, not writes into one live form.
- **Do not drop frames or images indiscriminately.** The visual form may be in an
  iframe, and bot protection can depend on resource loading. Browserbase warns
  against interception-based resource blocking on protected sites. Image blocking
  is primarily a proxy-bandwidth optimization for non-visual/non-protected work,
  which is unlike our current visual employer runner.
  [Resource-blocking caveat](https://docs.browserbase.com/optimizations/cost/cost-optimization)
- **Contexts are login storage, not a free paused browser.** Shared contexts can
  leak authentication and candidate data; saved context does not preserve a live
  form/submission. Use only future account/site-scoped opt-in contexts for proven
  login repetition. [Contexts](https://docs.browserbase.com/platform/browser/core-features/contexts)
- **Do not retry a send to get better metrics.** `submission_unknown` remains
  protected. Measure and optimize against generated employer fixtures.

## Measurement contract before claiming savings

Use the deployed environment's Browserbase configuration; the local `.env` used
earlier points at an old free project and is not a measurement of the upgraded
production account. No secret values need to leave the server.

Capture safe per-session metadata: application/revision identifiers, preparation
versus submission versus synthetic check, engine, region, session ID, start/end
times, outcome, assistance duration, model-turn count, screenshot count, and
phase durations. Do not record candidate answers, raw form payloads, control
URLs, screenshots, or tokens just to measure performance.

`GET /v1/sessions/{id}` / `bb.sessions.retrieve(id)` exposes `createdAt`,
`startedAt`, optional `endedAt`, `expiresAt`, `status`, `region`, `keepAlive`,
`projectId`, and `proxyBytes`. Compute observed lifetime from provider timestamps;
do not confuse client callback time or `expiresAt - startedAt` with actual usage.
[Session API](https://docs.browserbase.com/reference/api/get-a-session)

`GET /v1/projects/{id}/usage` / `bb.projects.usage(id)` returns `browserMinutes`
and `proxyBytes`. It is an aggregate meter, so concurrent unrelated jobs can
confound a before/after delta. Reconcile controlled synthetic cohorts with this
meter and the dashboard's billing-cycle view; session metadata can segment them.
The documented API does not return an authoritative per-session `billedMinutes`
or a per-session invoice amount.
[Usage API](https://docs.browserbase.com/reference/api/get-project-usage),
[usage tracking](https://docs.browserbase.com/optimizations/cost/measuring-usage)

For comparisons report separately:

1. Completed generated applications and duplicate submissions (must remain zero).
2. Sum of provider session runtime, plus per-session distribution and phase time.
3. Production project meter delta and session count, with billing rounding caveat.
4. Model input/output tokens, latency, calls, and failure/review rate.
5. Proxy bytes and candidate wall time.

No saving percentage is established by this research. The first implementable
set is: prefetch before launch, cheaper readiness polling, session-local
transport/page reuse, and safe timing/usage attribution. Then benchmark region,
native observations, and tightly scoped reuse without changing approval or
uncertain-send rules.

## Changes applied after the assessment

The initial assessment above records the pre-optimization implementation. The
follow-up code changes on 2026-11-02 apply the following recommendations:

- Profile and account reads run together before opening the submission browser.
- An idempotent release callback closes the browser after final receipt capture,
  before receipt inference and database confirmation. The immutable screenshot,
  observed controls/text and URL remain subject to the existing receipt checks.
- Receipt and human-readiness polls collect DOM/challenge state without JPEG
  capture. The two-second generated regression drops receipt images from nine to
  one (total test images from eleven to three), retaining a fresh final image.
- Fully approved, unchanged forms can fill and validate deterministically after
  one model review. The controlled send benchmark drops from four to two model
  calls including receipt verification, with one submit and identical answers.
  New required questions, late value changes and human challenges still stop or
  return to review. The actual-model generated local check passed with one
  discovery call, one fill/review call and one receipt call.
- The observed Virginia worker chooses `us-east-1` instead of the documented
  Oregon default; a validated `BROWSERBASE_REGION` override remains available.
  Unknown worker locations retain the provider default. No regional speed-up
  percentage is asserted.
- Safe release logs report client/work/cleanup milliseconds, region, API release
  acknowledgement and provider duration/status when returned by that same API
  call. They add no usage-lookup request and expose no session/control URLs,
  candidate answers or provider secrets. These durations are not billed minutes.

Session pooling, arbitrary cached locators, and cross-account browser/context
reuse were not introduced. The next targeted benchmark is session-local
transport/page-discovery reuse. Production project-meter savings must still be
measured across a representative period and reconciled to rounding; the test
call/image reductions do not establish a percentage reduction in billed hours.

### Hosted acceptance

Release `dpl_C2ZiGQULuG8rkS1DLvbsq5cnVWVu` is live. All 415 tests, ESLint,
TypeScript and production build checks passed. The source release also carries
forward the Inbox files from commit `a75876ee8fc24b24f367410de23c3176595b0a99`.

One generated hosted application completed, with exactly one receiver-confirmed
submission, matching approved answers/PDF, denied duplicate approval and both QA
accounts deleted. No real application was resent.

Provider-returned duration/status in that run:

| Phase | Region | Provider duration | Final status |
| --- | --- | --- | --- |
| Form discovery | us-east-1 | 7.351 seconds | COMPLETED |
| Approved fill/send | us-east-1 | 13.421 seconds | COMPLETED |

The submission browser's completed-state timing log was emitted at
`10:18:01.106Z`; receipt inference started at `10:18:01.107Z`. Thus the actual
hosted path released the browser before receipt-model work, not merely in mocks.
The receipt was confirmed at `10:18:02.196Z`.

The 20.772 seconds above are observed browser runtime across two sessions,
not an invoice measurement. Each session remains subject to the documented
one-minute minimum. There is no controlled before/after production project-meter
delta yet, so no billed-hour saving percentage is established.

Deployment persistence: the application sources and required deployed Telegram
dependencies are committed together, so subsequent Git-based deployments retain
the browser fixes and optimizations.
