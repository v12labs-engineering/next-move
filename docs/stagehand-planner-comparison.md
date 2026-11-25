# Stagehand form planner comparison

`APPLICATION_FORM_PLANNER=stagehand` is the default after hosted acceptance. The
planner uses native Stagehand structured extraction for question discovery and
application entry targets. Filling, missing-answer pauses, conditional-question
review and Next/Continue transitions use the existing application rules. The
model never supplies answers or receives a final-submit tool.

Both paths use the same observed-control binding, approved-answer checks, upload
hash verification, consent checks, final post-permission validation, persisted
send-intent callback and receipt verification. Existing `computer-v1` packets
remain compatible. No schema migration or new submission retry is introduced.

The native planner uses `APPLICATION_COMPUTER_MODEL` and the configured
OpenAI-compatible provider through Stagehand's client-model interface. Each
outgoing native model request reserves an application decision, including extra
requests Stagehand makes within one extraction. Transport retries, selector
self-healing and inference caching remain disabled. Perception calls are
serialized within each isolated browser. Provider failure stops the native path;
it does not silently fall back to the screenshot planner.

Native extraction reads the actual current page, including values already filled
by the application, through the configured model provider. Screenshots are not
needed for native planning. The independent receipt check retains its existing
configured model and screenshots. No browser snapshots, answers or credentials
are added to comparison summaries or application logs.

## Paired generated-form harness

Run from the repo root:

```sh
node --import tsx scripts/compare-application-planners.mts --refresh-oidc
```

This executes both planners serially on identical generated HTML, with fresh
browser sessions for each run and for missing-answer continuation. It uses the
existing staging Browserbase credentials and gateway setup from
`scripts/verify/verify-computer-agent.mts`. It contacts no real employer. Five cases cover
a basic application, delayed dropdown plus conditional salary and multiple pages,
an iframe containing a shadow-root form, a simulated human verification gate,
and the guide-style radio/checkbox/select/text controls described below.
The salary must remain unanswered until explicitly supplied. Successful cases
assert exact identity values, untouched optional consent, a verified receipt and
exactly one generated submission.

Local Chromium can exercise real Stagehand extraction with the same configured
model for both planners, without consuming Browserbase minutes:

```sh
APPLICATION_TEST_CHROME_PATH='/absolute/path/to/chromium' \
  node --import tsx scripts/compare-application-planners.mts \
  --native-local --refresh-oidc
```

Omit `APPLICATION_TEST_CHROME_PATH` when Playwright's expected Chromium is
installed. `--case=basic` selects one case. `--repetitions=2` repeats the corpus
and reverses planner order on the second pass. Each run writes private receipts
and a safe `summary.json` under ignored `.local-data/planner-comparison-*`.
Summaries include HTML hashes, success/failure, elapsed wall time, decision
reservations, native model requests and synthetic submission counts. Wall time
includes browser launch and cleanup. Failures remain in the report and make the
command exit unsuccessfully.

Hosted comparisons preserve the existing computer planner's managed Browserbase
model for its supplementary native hint. The native planner uses the configured
application model. Local comparisons pin both to the same application model.
Report that distinction when interpreting results. A small generated corpus is
not a production employer support matrix or a statistically reliable success rate.

## Switch criteria and rollback

The default switch requires both paths to run on the generated corpus and the
native path to pass hosted acceptance. Compare correct completion, model
requests, elapsed time, missing-answer behavior and safe failure outcomes. A
faster run alone cannot justify a switch. Regressions must still establish zero
submits for invented targets, omitted required controls, unapproved answers,
changed uploads and late post-permission mutations; uncertain sends must remain
blocked from automatic retry.

These criteria passed for the preview deployment recorded below. Setting
`APPLICATION_FORM_PLANNER=computer` explicitly retains the prior planner for
rollback; invalid values fail closed. The packet format and submission guards
are shared across both paths.

## Results

On 2026-11-03, the initial hosted pair stopped before browser execution with an
account-limit failure on both paths. This provides no evidence about relative
planner quality. A read-only project usage check reported 61 browser minutes.
No plan or account allowance was changed.

The initial four-case local comparison passed all eight runs (four per planner),
using real Stagehand 4.3 extraction and `alibaba/qwen3.7-flash` for both planners.
Receipt checks used `anthropic/claude-haiku-5.5` on both paths. Each passing run
produced exactly one synthetic submission and preserved optional consent. The
conditional case paused for the unanswered salary, then continued in a fresh
browser after the explicit answer. These are single samples, not reliability
percentages.

| Generated case | Computer wall time | Stagehand wall time | Computer charged decisions | Stagehand charged decisions |
| --- | ---: | ---: | ---: | ---: |
| Basic form | 22.2 s | 13.9 s | 6 | 5 |
| Delayed dropdown, conditional salary, multiple pages | 49.3 s | 49.4 s | 14 | 15 |
| Iframe with shadow-root form | 23.0 s | 13.8 s | 7 | 5 |
| Simulated human verification | 19.1 s | 14.4 s | 6 | 5 |

Evidence is in ignored
`.local-data/planner-comparison-2026-11-03T10-33-18-972Z/summary.json` and its eight
private receipts. Counts include discovery, filling, missing-answer continuation
and final receipt inference. Native extraction used multiple internal model
requests, all charged individually. The complex case used more decisions and
showed no speed improvement; the result does not support claiming that Stagehand
is universally faster or more reliable.

All 545 automated tests, TypeScript, ESLint and the production build passed. The
function-bundle check reported no budget violations. The new guard regressions
cover invented targets, omitted required questions, model-supplied answers,
missing salary, late changed values, duplicate confirmation, per-request quotas,
RPC callback context, model failures and concurrent perception. One existing
queue-test fixture was trimmed to its declared user-ID type so TypeScript could
complete.

The initial standalone hosted checks used a stale local Free project. The
investigation and successful preview acceptance below supersede that blocker.

## Browserbase form-submission guide coverage

The reference is Browserbase's
[automating form submissions guide](https://docs.browserbase.com/use-cases/automating-form-submissions).
Its Stagehand/Playwright session → navigate → fill → submit → verify flow maps to
the implementation in [application-browser.md](application-browser.md).

The comparison corpus now also includes `guide-form-controls`, a generated form
with wrapped radio labels, grouped multi-value checkboxes, a native select and a
textarea, alongside identity fields, the approved resume and separate optional
consent. Its receiver independently checks the exact selected radio, both approved
checkboxes, the unchecked alternative, the select's submitted value and the
source-backed text before producing a receipt. Each question must be discovered
exactly once with the right control kind. Run only this pair with:

```sh
APPLICATION_TEST_CHROME_PATH='/absolute/path/to/chromium' \
  node --import tsx scripts/compare-application-planners.mts \
  --case=guide-form-controls --native-local --refresh-oidc
```

The default comparison command runs this fifth case as well. It uses a generated
receiver rather than submitting responses to the guide's external Google Form.

The guide-style pair passed on 2026-11-03 using the same models and local native
Chromium setup as the initial comparison. Computer took 33.7 seconds with seven
charged decisions; Stagehand took 17.8 seconds with five. Both discovered the
question groups correctly, preserved exact approved choices and text, left
optional consent unchecked and produced exactly one synthetic submission.
Matching HTML hashes and `guideControlsVerified: true` are recorded in
`.local-data/planner-comparison-2026-11-03T10-48-25-097Z/summary.json` and its two
receipts. TypeScript, ESLint and diff whitespace checks also passed. This adds
local coverage for the guide's control types.

## Hosted acceptance and default selection

The exact local provider error was HTTP 402: "Free plan browser minutes limit
reached." That project's usage was 61 browser minutes, with zero running sessions
and concurrency three. A no-proxy session failed too, ruling out proxy bandwidth
and concurrent browsers as the immediate cause. The sanitized probe is in
`.local-data/browserbase-limit-diagnosis.json`.

The signed-in Browserbase dashboard identified a separate Developer workspace
named "Vercel workspace", with the "Vercel production" project. Its project ID
differs from both local `.env.local` and `.env.staging.local`. Vercel stores the
managed Browserbase values as non-readable Secrets for Production and Preview;
they were neither exported nor replaced. No Browserbase plan was upgraded.

Preview `dpl_AHWPSfsE8X9VaJd7TYK7zgxu4s1o` explicitly selected `stagehand` at build
and runtime, and used those existing managed credentials. Its hosted acceptance
stored an employer-harness receipt at `2026-11-03T11:08:35.384Z`. The generated run
verified missing-answer handling, actual tailoring, exact approved answers and
PDF, stale-revision rejection, cross-account read/edit/approve denial, RLS,
duplicate approval rejection and exactly one confirmed synthetic submission.
Both generated accounts were deleted. No real employer was contacted. Evidence
is in `.local-data/hosted-stagehand-preview.log`.

The source default was changed to Stagehand only after that preview passed.
Production build `dpl_4Q3ts69VAaGWZ3ZXZRZxM4EjcuXK` was staged without a planner
override and passed the same full hosted acceptance flow. Its receipt was saved
at `2026-11-03T11:15:36.628Z`; the receiver counted one submission and both
generated accounts were deleted. Runtime logs explicitly identified `stagehand`
during discovery and filling. There were no error-level runtime logs in the
scanned 15-minute verification window. All 545 tests, TypeScript, ESLint,
production build and function-bundle checks passed after the default change.

That exact tested production build was then promoted. The previous screenshot
planner is available with `APPLICATION_FORM_PLANNER=computer`. Safe runtime logs
identify only the planner and discover/fill phase, with no candidate answers,
credentials or control URLs. Evidence is in
`.local-data/stagehand-hosted-preview-result.json`,
`.local-data/stagehand-hosted-default-result.json`,
`.local-data/stagehand-default-runtime-logs.jsonl`,
`.local-data/stagehand-default-planner-logs.jsonl`, and
`.local-data/stagehand-live-release-check.json`.

The old standalone comparison commands still read the local Free credentials.
Their 402 error does not describe the deployed Developer workspace. For hosted
acceptance with non-readable Vercel-managed Secrets, deploy the reviewed source
with the existing project environment and use
`scripts/verify/verify-application-runner.mjs --synthetic-only --deployment=URL` with the
canonical synthetic receiver. Do not export production Secrets to repair a local
test harness or substitute a different database/account.
