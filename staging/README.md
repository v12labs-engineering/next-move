# Staging rollout

## Account application queue (2026-11-03)

Deployment `dpl_qX2QQ3AovNyvffFZ15YtjWwDQiLK` is READY and promoted at
`https://job-search-chi-amber.vercel.app`. Only
`202611030045_application_queue.sql` was applied to the verified isolated
Supabase project; unrelated pending catalogue and Telegram migrations remain
unapplied. Remote migration history confirms the queue migration.

Concurrent hosted Postgres requests verified one active application per account,
FIFO claims, duplicate rejection, independent accounts, review/cancellation
release, RLS isolation, long queued approvals and uncertain-send protection.
The staged API verified separate queued/in-flight counts and filters. The live
Applications page passed desktop/mobile stage, count and filter checks with no
runtime errors or horizontal overflow. All generated test accounts were deleted;
no AI provider, employer browser or real employer application was used.

The release was uploaded by CLI from the queue changes on baseline
`a8194400512604829326b45a2456026d7d488b5f` before their Git publication. Source
hashes, migration receipt, hosted checks and screenshots are retained under
ignored `.local-data/application-queue-*`.

## Telegram review connector (2026-11-02)

Deployment `dpl_BLyPQSY24Vs1UWXAgQ3NMhHuQAzu` is READY at the existing
`https://job-search-chi-amber.vercel.app` alias. It replaces the unused WhatsApp
connector with Telegram while preserving the live catalogue source and cron
configuration. Only migration `202611020038_telegram_approvals.sql` was applied;
the earlier unrelated pending catalogue migrations were not included in this
release. All four Telegram tables have RLS enabled. No WhatsApp tables were created.

Bot `@V12NextmoveBot` has the app callback registered, with private token/secret
configuration and help/stop/privacy commands. Invalid and valid webhook secrets
returned 401 and 200, respectively. Telegram's readback reported the correct URL,
zero pending updates and no delivery error. A generated account's Preferences page
rendered Telegram settings after its required destination country was populated;
the account fixture initially omitted that required field. The real user's profile
was not inspected or changed.

Local verification passed 337 tests, lint, TypeScript and the production build;
the isolated hosted release also built successfully. Live verification recorded
one real connected account, one delivered application notification and zero
recorded notification failures; the user confirmed the connection was working.
The account-isolation guard rejected linking that same Telegram identity to the
separate generated QA account. Approval-to-submission and an employer receipt
remain untested live. Setup details are in
[Telegram application review](../docs/telegram-notifications.md).

This is an isolated environment, not a branch or copy of the existing private
database. `project.json` records non-secret resource identities. Credentials go
only in the ignored `.env.staging.local`, using `environment.example` as a guide.

## Current external state (2026-10-29)

- Dedicated Vercel project `job-search-staging` under `v12labs-projects` is live at
  https://job-search-staging.vercel.app. Node 24, staging-only environment values,
  and default deployment protection are configured. The existing V12 Labs site
  and original private database were not changed.
- New Supabase project `zcaqbiejkvgqxsbrncty` (`job-search-staging`) is healthy in
  Seoul (`ap-northeast-2`). All nine migrations were applied and local/remote
  history matches. A subsequent CLI dry run reports the database is up to date.
- Staging public and secret API keys are in owner-only `.env.staging.local` and
  the dedicated Vercel project's environments. Management credentials remain
  in the CLI credential store; database migrations use a temporary login role.
- Auth site URL and the sole allowed callback are the exact staging origin and
  `/auth/callback`, saved and read back in the Supabase dashboard. Email
  confirmation remains enabled. The user completed the real email signup.
- Live anonymous profile access is denied by Postgres; private application APIs
  return 401 and private pages redirect to sign-in.
- Removed both STAGING QA catalogue fixtures at the user's request and verified
  the fixture count is zero. No dependent drafts existed. A recovery copy is
  retained in ignored, owner-only `.local-data/qa-jobs-removal-backup.json`.
- Fixed the onboarding strict-pick validation bug. Browser verification passed
  all three steps, text resume upload/extraction and profile save. A synthetic
  backend profile produced a 100% backend evidence match and 40% designer match.
  The user is now replacing that initial synthetic profile with their own data;
  subsequent QA uses separate synthetic accounts and does not edit their account.
- The fix is deployed as `dpl_2y9iF4BwkAvMLewhC3GUqpRktSp1`. Billing remains
  outside this work. Provider/export/isolation acceptance results are recorded
  below as they are executed; deployment alone does not prove those checks.

## Provision and migrate

1. Authenticate the Supabase management account and the Vercel CLI (`vercel login`)
   that owns the V12 Labs team. Do not paste tokens into chat.
2. Create a fresh Supabase project named `job-search-staging`. Do not select the
   private project's ref or copy its data. Check any infrastructure charges before
   accepting a paid provisioning step.
3. Record its ref in `project.json`, and put that project's URL, publishable key and
   service key in `.env.staging.local`. Keep
   the existing `.env.local` unchanged. Set file permissions to owner-only.
4. Run `npm run staging:check` to verify the live project's identity and inspect
   its migration history. `npm run staging:plan` only lists local migration
   checksums and does not connect to a database.
5. Run `npm run staging:migrate` for a Supabase CLI dry run, then
   `npm run staging:apply` to apply the reviewed migrations. The helper uses pinned Supabase CLI 2.122.0 with an explicit staging project ref
   and a brokered temporary login role, leaving any original CLI linkage alone.
6. Run `npm run staging:check` again. Confirm all nine expected migrations are
   present and RLS is enabled. Do not seed private production profiles or resumes.

## Deploy and configure

1. Use the dedicated Vercel project's protected stable alias for staging. Keep
   deployment protection enabled and do not modify the existing `v12labs` project.
2. Set staging-only Supabase public configuration and any operator-only secrets.
   Never copy `.env.local` wholesale. The service key is not needed by customer
   routes. `.vercelignore` excludes all local environment files and test data.
3. Configure `TAILORING_BASE_URL=https://ai-gateway.vercel.sh/v1` and a model from
   the live Gateway catalogue. On Vercel, this exact endpoint uses the official OIDC helper to read the
   request-scoped token (with an environment-token fallback); no developer-local proxy or long-lived provider key is
   necessary. A live call must still confirm credit availability and output.
4. Record the deployed HTTPS origin in `project.json` and run
   `npm run staging:auth` if an optional management token is configured, or save
   the exact site/callback URLs in the dashboard. Keep email confirmation enabled
   and anonymous sign-in disabled. SMTP credentials are not overwritten.
5. Confirm SMTP delivery is configured for the test inbox. Do not disable email
   verification to make signup tests pass. A generated admin link does not prove
   email delivery.

## Full acceptance flow (must be executed before billing)

- With a fresh inbox/account, submit the browser signup form, receive the email,
  follow its real link in the same browser, and arrive at onboarding.
- Complete all three steps using explicitly labelled staging test data. Import a
  resume, review its extracted text, save, refresh and verify persisted values.
- Use real sourced listings or clearly labelled staging fixtures. Confirm ranked
  matches, reasons, sponsorship exclusions and country/work-mode preferences.
  Test fixtures are never reported as actual job leads or hiring activity.
- Mark a job interested, refresh, then applied. Verify the independent account
  state and the application list.
- Request tailoring against a description with sufficient evidence. Confirm an
  actual provider response, recorded usage, source references, persisted draft,
  manual edit/save and a valid DOCX download containing the saved text.
- Sign out and sign in again. Confirm session refresh and the same profile,
  statuses and drafts. A second account must not read/edit/download the first
  account's data, via either the UI or direct authenticated API requests.
- Check missing descriptions, invalid forms, stale profile edits, provider
  failures and daily limits. Failures must not create completed drafts.
- Record the deployed URL, migration versions, exact successful checks and any
  blocked boundary in this document. Do not infer success from a started run.

## Offline verification available now

`npm run lint`, `npm run typecheck`, the production build, and 79 tests pass. The tests include staging
target rejection, output redaction and preventing OIDC credentials from being
forwarded to arbitrary provider hosts, plus source-grounding, overlapping-date, unknown-value and legacy-profile
compatibility checks for resume-first onboarding. They do not replace the live flow above.

## Resume-first onboarding update

The questionnaire is replaced by resume upload/paste → AI extraction → candidate
review → confirmed save. Extracted employment, education, projects and highlights
retain source passages. Unsupported facts are discarded; name/headline/skills/
search roles can be corrected when absent. Location and experience duration can
remain unknown. Overlapping employment dates are counted once and year-only
experience is explicitly approximate. No nationality or immigration need is
inferred. Search starts across supported countries and all work modes, with
optional preferences and an explicit unknown sponsorship setting.

The profile JSON now optionally stores `resumeInsights`; existing saved profiles
continue to parse. No schema migration is needed. `/api/profile/analyze` requires
a verified account, same origin, bounded resume text, and the shared 10-per-day
AI attempt reservation. It does not save a profile until the user confirms.
Uploaded files are extracted and discarded; the UI explains the AI transfer.

Live checks for the new analysis endpoint confirmed anonymous 401, cross-origin
403, malformed input 400, and resume-first HTML for a fresh authenticated test
account. The first provider check exposed an environment-only OIDC lookup;
Vercel Functions supply the token in request context. The implementation now
uses `getVercelOidcTokenSync()` with the exact Gateway endpoint guard, preserving
explicit provider-key precedence. Two regression tests cover that boundary.
The runtime OIDC mechanism is documented at https://vercel.com/docs/oidc.

Current resume-first deployment: `dpl_148RDzWLcmiqe2SavLSpGQLK8HS3`, ready at
https://job-search-staging.vercel.app. Existing profile search preferences are
preserved when a resume is replaced. Authentication smoke checks pass for all
11 private API operations and six private pages, including the new analysis
endpoint. No additional migration or billing changes were made for this update.

## Live AI acceptance results

The previous AI Gateway HTTP 402 credit blocker is resolved. On the dedicated
staging deployment `dpl_55gx61EzzeYV8buJT5XqYiZQBokD`, a separate synthetic account
completed the new resume-first path: onboarding HTML 200, analysis API 200 with
grounded career/education, profile PUT 200, and profile GET 200 rendering the
saved career history. Anonymous 401, cross-origin 403 and malformed-input 400
checks pass. The provider is `alibaba/qwen3.7-flash` with reasoning disabled.

A direct service call using a synthetic resume and in-memory synthetic job
also selected a relevant verbatim passage with the actual provider. Reported
usage: 289 input / 9 output tokens. No job listing was inserted for this check,
and the QA catalogue fixture count remains zero. This verifies live passage
selection; a full job → draft persistence → DOCX browser flow remains a separate
acceptance check requiring a genuine catalogue listing.

The resume-first screen was inspected in Chrome and captured at ignored
`.local-data/resume-first-onboarding.png`. The user's own profile was read only;
QA has not overwritten it. Existing search preferences survive replacement.

## Cost-first model configuration

As requested, staging now selects `alibaba/qwen3.7-flash` for both profile
analysis and resume passage selection. The live Gateway catalogue on 2026-10-29
lists $0.03 input / $0.13 output per million tokens below 32K context. This is a
price snapshot, not a quality claim; `staging/ai-model.json` records the choice.
`TAILORING_REASONING=none` disables reasoning for this compatible model. Requests
send a JSON schema, retain 5,000/1,000 output token limits, have zero application
retries and do not configure a premium model fallback. An SDK request-level test
verifies the schema, reasoning setting and token caps on both actual call paths.

Gateway credits are now funded: a read-only balance check returned HTTP 200 and
a positive balance. The prior `insufficient_funds` boundary is resolved; model
accuracy and deployed extraction passed checks against a separate synthetic
account. The user's own profile and the empty QA job catalogue remain untouched.

## Live catalogue and recommendation repair

The empty applicant view was reproduced against staging: `job_catalog` contained
zero rows after the two QA fixtures were removed. The old refresh re-ranked
existing rows without fetching new ones. A strict default sponsorship filter
also hid related roles whose postings did not explicitly promise sponsorship.

Added a separate shared catalogue sync for verified public employer boards n8n,
DeepL, Mistral AI, ElevenLabs and Linear, plus the documented Arbeitnow API.
It retains full source descriptions, published dates and direct job URLs; uses
explicit country metadata (including secondary locations); distinguishes hybrid
from remote; skips unlisted, malformed and unknown-geography postings; and never
uses an employer register as role-level sponsorship proof. A Germany-only visa
commitment is not copied to other countries.

Migration `202610290002_live_catalog.sql` is applied and all ten local/remote
migration versions match. Source snapshots publish atomically, with per-source
leases, success/error state and inactive markers instead of deleting saved job
history. Failed fetches leave the last successful snapshot intact. Candidate
queries omit listings not checked for seven days, page past Supabase's 1,000-row
cap, score using full descriptions on the server, and omit descriptions from
list responses to keep payloads small. Location variants of one URL collapse
into one opportunity, preserving the user's saved variant.

The first live refresh succeeded for all six sources: n8n 79, DeepL 5, Mistral AI
70, ElevenLabs 71, Linear 4 and Arbeitnow 268 job-location records, total 497.
These are source records, not a claim of 497 unique suitable jobs. QA fixture
count remains zero. No applicant profile or preferences were edited.

`/api/catalog/sync` is operator-only with an encrypted `CRON_SECRET`. The deployed
`vercel.json` schedules an awaited daily refresh. The manual run and next platform
cron execution must be distinguished; a configured schedule is not proof of a
future run. Customer Refresh reads the current catalogue and does not launch
scrapes or use a service key.

Recommendations recognize related professional titles and common skill aliases.
Relevant roles with uncertain visa/work details appear explicitly for review;
strict preference fit remains an optional view. Explicit sponsorship refusals
and excluded companies are not fallback recommendations. Unrelated jobs cannot
become matches merely through location/visa points. Percentage ratings were
removed from applicant cards, which now explain fit and missing evidence.

92 tests pass, including atomic publication, source permissions, safe expiry,
country-scoped sponsorship, uncertain-match visibility and duplicate-location
handling. Lint/typecheck pass. Staging deployment verification is recorded below.

Final live verification: the protected deployed sync rejected anonymous access
with 401 and completed an authenticated refresh with HTTP 200 and all six sources
successful. The refreshed catalogue contains 500 active job-location records.
Final duplicate/relevance rules produce 383 distinct opportunities in this
applicant's countries and 59 related roles for review. None currently confirms
all of the applicant's sponsorship + onsite preferences; that uncertainty is
shown explicitly rather than manufacturing confirmed matches. The profile and
preferences were unchanged. A browser reload of the final deployment confirmed 59 relevant roles,
383 active listings in the selected countries, and visible source attribution,
fit explanations and visa/work uncertainties. Screenshot proof is saved at
`.local-data/live-job-matches.png`.

A separate synthetic account completed the real job flow using adjoe's published
Staff Go Backend Developer role: job status persisted, the Qwen provider returned
a source-backed draft (HTTP 201), manual edits saved, DOCX download returned 200
and contained the edit, another account's download/edit attempts returned 404,
the application page rendered, and signing out made the API return 401. No QA
job was inserted. Verification artifacts remain under ignored `.local-data/`.

Latest deployment: `dpl_4AyMRddZTSWryEm7BQRaaLYUpLGD`. Matching is deterministic
and does not consume AI credits; live AI remains on the low-cost configured model.
The daily cron is configured; its next automatic invocation has not yet occurred.

## Approval-first application runner (2026-10-29)

Provisioned Browserbase `job-search-staging-runner` using the FREE plan after the
user accepted terms. Only the two new provider keys were merged into the private
staging env; `.env.local` was not changed. Browserbase is connected to the dedicated
Vercel staging project. Billing integration remains outside this release.

Migrations 003_destination_countries, 004_application_runner and
005_application_claim were applied to the isolated staging project through the
signed-in Supabase SQL editor after the pinned CLI's management lookup hung.
Guarded transactions checked expected history before applying exact files and
recording their statements in schema_migrations. Readback shows 13 migrations;
SHA256 of all three stored payloads matches the local files. All three runner
tables have RLS enabled and authenticated roles lack direct UPDATE privileges.
The QA catalogue fixture count is still zero.

The first deployed synthetic end-to-end run confirmed Browserbase discovery,
actual Qwen tailoring, required-answer validation, stale approval rejection,
cross-account API/RLS isolation, approved DOCX/answers at the synthetic receiver,
duplicate approval rejection and exactly one confirmed browser submission. All
candidate details were newly generated fictional data; no employer was contacted.
Final deployment and UI acceptance evidence are recorded after the final run.

Final browser checks: the fictional applicant's submitted packet rendered its
receipt and approved version. Editing the private, unapproved n8n packet saved,
advanced its revision and survived reload; the unsupported required picker kept
Approve & submit disabled. n8n discovery captured 28 fields, 18 required, with
one unsupported required location autocomplete. No candidate data was entered
on that real employer form and no real application was approved or submitted.

The server-side token-hash email confirmation route follows Supabase's documented
verifyOtp flow alongside the existing PKCE callback. A generated link for the
fictional account opened its private review page; replay redirected to the
expired-link screen. No email was sent and this does not claim email-delivery QA.
Anonymous application listing and approval return 401. Receipt and review UI
screenshots are retained in ignored `.local-data/`. Current local verification:
103 tests pass, lint/typecheck/build pass, production dependency audit is clean.

Final release is Ready as `dpl_DkrAtqRUiAx6A9WSiBTpunAgyNqN` at
https://job-search-staging.vercel.app. The acceptance script was rerun against
this exact release and passed: persisted synthetic profile and actual catalogue
matching (200), live model tailoring, required/stale approval rejection,
other-account read/edit/approve denial (404), duplicate approval rejection (409),
and one managed-browser submission confirmed by the synthetic receiver. Its
application ID is `30b566d8-c0c7-41fb-8499-162060771907`; the receiver checked the
approved answer values and DOCX text and recorded one submission. Evidence:
`.local-data/application-runner-verification.json`,
`.local-data/application-receipt-verified.png`, and
`.local-data/application-review-verified.png`. The isolated UI test account was
signed out after verification. The user's real account was not edited.

## India / Hyderabad coverage correction (2026-10-29)

The live catalogue had zero India records although the applicant's saved
destination was India / Hyderabad, Telangana. Seven previously interested
vacancies from other countries were being counted as listings in the search.
Added public Greenhouse employer feeds for New Relic and Deliveroo; source
publication persisted 15 India job-location records, including 10 Hyderabad
records. These are actual employer listings, not QA jobs. Per-location IDs
preserve multi-city postings, and duplicate selection now prefers a reviewable
location variant over another city when neither is a confirmed fit.

Final deployment `dpl_3HXVp6VQj6eJ3xuzQb6YwySUrktk` is Ready at the existing
staging URL. A browser reload and India filter confirmed two reviewable Deliveroo
vacancies: Staff Software Engineer (8202442) and Senior Software Engineer
(8311914). Neither is represented as confirmed sponsorship or onsite work; the
New Relic role explicitly refusing sponsorship remains excluded under the
applicant's existing requirement. Profile version and saved locations were
checked before/after ingestion and remained unchanged. No application was sent.

106 tests, lint, TypeScript and the production build pass. Country coverage
counts exclude saved jobs outside the selected countries, the empty state
distinguishes missing supply from preference mismatch, and verified Greenhouse
source labels identify the employer rather than linking to Arbeitnow.

## Measured collection and candidate relevance — 2026-10-29

Applied only the additive `202610290006_catalog_collection.sql` and
`202610290007_catalog_backoff.sql` migrations to the isolated staging database.
The original private database was not migrated. Application changes were tested
with a local production build configured for staging; they were not deployed.

Read-only audit before collection measured 667 distinct vacancy-and-country
pairs across 18 destinations. After seven employer-source snapshots completed,
the audit measured 1,586 such pairs across 48 destinations. These counts collapse
same-URL location variants within a country; they are not unique worldwide jobs,
market coverage percentages, or candidate matches. The source directory still
has eight enabled sources. Two hundred selectable destinations have no assigned
source scope in the directory; no worldwide supply guarantee is established.

All five configured Ashby employers and both Greenhouse employers completed
measured snapshots. Arbeitnow checkpointed 17 pages (3,775 raw postings,
2,247 rejected postings and 21 HTTP requests including retries), then received
HTTP 429. Its run remains paused at page 18. Previous published listings remain
available within the freshness policy; staged incomplete data is not published.
The follow-up migration persisted its retry time, and a subsequent collector
invocation correctly reported backoff without another provider request. Recovery
past that provider backoff has not been verified live.

Final checks: lint, TypeScript, all 121 tests, production build, dependency audit
(zero vulnerabilities) and anonymous access smoke checks passed. Isolated
Postgres tests cover stale-worker fencing, interrupted checkpoints, duplicates,
atomic expiry, more than 5,000 staged records, insert/update observation times,
operator-only run/demand access and durable deferral. Standards and Spec reviews
found and resolved scoring, profession, timestamp, pagination and count issues.

Generated QA accounts against the local production server verified authenticated
profile save -> account API -> real catalogue -> browser rendering. The backend
engineer fixture received 14 relevant jobs (11 Germany, three India); the
registered nurse fixture received zero. Country counts matched the deduplicated
account response. The lack of nursing supply is a measured gap, not permission to
pad recommendations. No QA listing was inserted, no resume AI was invoked and
no employer application was prepared or submitted. Temporary QA accounts were
deleted after checks; existing applicant profiles were not modified.

Local evidence (ignored, not credentials):

- `.local-data/catalog-baseline-before.json`
- `.local-data/catalog-baseline-after.json`
- `.local-data/catalog-qa-receipt.json`
- `.local-data/catalog-qa.png`

The six-hour GitHub Actions workflow is prepared but disabled until repository
configuration and included allowances are verified. This checkout has no Git
remote configured. No repository, Actions secrets, paid plan or automatic
six-hour execution was created. Source expansion and cross-language occupation
matching remain explicit coverage work; the current implementation measures
those gaps instead of claiming that all professions are adequately served.

## Staging deployment of all application changes — 2026-10-29

The current application working tree was uploaded to the existing isolated
`job-search-staging` project. Final deployment
`dpl_AZdYpgGndFKUoCVq3BBCuaw3ioqW` is Ready and assigned to
https://job-search-staging.vercel.app. Remote build and TypeScript passed.
Environment metadata confirmed the isolated Supabase URL and APP_ENV=staging;
local environment files and QA exports were excluded from uploads.

Deployed anonymous API/page and cross-origin signout checks passed. Generated
QA accounts verified authenticated profile saving, account-specific matching,
country coverage counts and real browser rendering on the final release.
The backend fixture received 48 relevant roles after collection recovery; the
nurse fixture received zero. Both generated accounts were deleted. Existing
applicant profiles and resumes were not modified. The verification script now
restricts its If-Match header to profile PUTs; sending it on GET incorrectly
triggered the hosting layer's HTTP 412 precondition response.

The deployed operator endpoint rejected anonymous access, then resumed the
previous Arbeitnow run at page18 and completed its 1,732 staged listing-location
records. This verifies live recovery after provider backoff; it is separate
from successful automatic scheduled execution. All eight sources now have a
completed measured snapshot. The six-hour GitHub Actions workflow remains
inactive pending repository configuration and verified free allowances.

Ignored local evidence:

- `.local-data/catalog-qa-deployed-receipt.json`
- `.local-data/catalog-qa.png` (latest deployed browser check)
- `.local-data/catalog-deployed-collector-receipt.json`
- `.local-data/catalog-final-deployment-collector.json`

No production application, private database, paid plan, Git remote or Actions
secrets were changed by this staging deployment.

## Six-hour GitHub collection activated — 2026-10-30

The user explicitly approved storing staging's existing `CRON_SECRET` as the
private repository's encrypted `JOB_CATALOG_TRIGGER_SECRET`. That is the only
repository secret. No database service-role credential was transferred.
`JOB_COLLECTION_ENABLED=true` and the active `catalog.yml` workflow enable
collection from `main` at 00:17, 06:17, 12:17 and 18:17 UTC (05:47, 11:47,
17:47 and 23:47 IST). The existing account zero-spend controls were unchanged.

The first manual invocation authenticated successfully but stopped with a
healthy page-11 checkpoint after the endpoint's ten-page batch. Scheduler commit
`972b3c8` adds bounded continuation: at most five endpoint calls within a
five-minute runner budget. Source failures, provider backoff and active leases
stop continuation instead of causing a retry loop. Regression tests cover
continuation, no-spin behavior, request bounds and the fixed credential recipient.

Manual verification run 40977623586 completed successfully on that commit:
https://github.com/v12labs-engineering/job-search/actions/runs/40977623586.
Its result was `ok=true`, `complete=true`, eight enabled sources and two endpoint
batches. Arbeitnow resumed the saved snapshot and published 1,781 listing-location
records. These are source records, not a claim of candidate relevance or new jobs.
The runner used the trigger credential; the database key remained on Vercel.
The first automatic invocation of the enabled schedule has not yet been observed.

Evidence: ignored `.local-data/catalog-github-run.log`. A successful manual run
verifies dispatch, credential scope and collection continuation; GitHub scheduling
can still be delayed, and exhausted free allowances can stop future runs.


## Site-independent application rollout (2026-10-30)

- Stable URL: https://job-search-staging.vercel.app/jobs.
- Deployment `dpl_8ohNGAMbTjxUnZQw71HTqg3QQbru` is READY in the isolated
  `job-search-staging` project. Its immutable URL is
  https://job-search-staging-nqheyb31i-v12labs-projects.vercel.app.
  This was a CLI upload of the tested working tree over base commit `c1841a1`;
  deployment metadata's base Git SHA does not mean the changes were committed or
  pushed. No separate production project was deployed.
- Applied `202610300001_automatic_applications` and
  `202610300002_site_independent_applications` to the isolated Supabase project
  `zcaqbiejkvgqxsbrncty`. The rollout check recorded both new versions in the
  17-entry applied migration history. Existing auth settings were not changed.
- Refreshed the hosted Jobs view in Chrome and confirmed Tailor & apply is visible
  on both Greenhouse listings. No real applicant application button was clicked.
- `node scripts/verify/verify-application-runner.mjs --automatic` passed actual hosted
  workflow start, managed-browser discovery, configured-model tailoring,
  missing-answer pause, edits, stale-version rejection, cross-account read/edit/
  approve denial, atomic continuation, one form submission and a confirmation.
  Synthetic run: `9c8d9aa3-a47d-4d54-a481-5b49ee3a7377`.
- `node scripts/verify/verify-application-runner.mjs --automatic-queue` passed the same
  preparation/ownership checks, then re-requested automatic application after
  saving complete answers. Duplicate starts returned the same run and the
  synthetic receiver recorded exactly one submission. Synthetic run:
  `0896e713-3170-4183-bab1-f38e2a5dac93`.
- Both runs use generated fictional accounts/resumes and an unpredictable
  staging-only synthetic employer destination. They reference public catalogue
  metadata without creating QA listings or contacting the actual employer.
  The receiver checks the submitted answers and DOCX against the stored snapshot;
  receipt-backed Applied status was verified only in each fictional account.
  Private evidence is in ignored `.local-data/application-runner-verification-automatic.json`
  and `.local-data/application-runner-verification-automatic-queue.json`.
- `SMOKE_BASE_URL=https://job-search-staging.vercel.app node scripts/verify/smoke-auth.mjs`
  passed 18 anonymous API denials, six private-page redirects, sign-in rendering
  and cross-origin sign-out rejection. Deployment error/fatal log inspection
  returned no matching records in the checked ten-minute window after the first
  synthetic run.
- Local lint, TypeScript and 144 tests passed before upload; the hosted Next.js
  production build completed successfully. Verification script changes are local
  test helpers and do not alter the deployed runtime.

These are controlled staging submissions, not applications to real employers.
Provider-specific widget variations, login/OTP/CAPTCHA handoff, and full hosted
network-isolation acceptance remain public-release gates. Billing and other
existing production launch gates still apply.


## Employer discovery and automatic expansion (2026-10-30)

The isolated staging deployment `dpl_CDuLS9g5qe4DY763NzjtBmjZ8Yrv` is READY at
https://job-search-staging.vercel.app. Its immutable URL is
https://job-search-staging-oh3nq8erl-v12labs-projects.vercel.app. This is a CLI
upload of the tested working tree; it does not imply all working-tree changes
were committed or pushed. No separate production project was deployed.

Applied discovery migrations `202610300003`, `202610300004` and
`202610300005` only to `zcaqbiejkvgqxsbrncty`. Imported 13,383 distinct historical
board candidates with 21,244 provenance observations from four pinned files.
Repeating the import added zero candidates or observations. Missing per-row
Open ATS Feed observation dates remain unknown.

The earlier ten-candidate pilot activated seven boards. Two additional automatic
batches processed 30 candidates each: batch one verified and activated 26, and
batch two verified and activated 24. Across these additional batches, four
candidates needed review, three were missing and three were deferred; none of
those ten were activated. Total directory size is now 65 enabled sources,
including 57 activated imported candidates and the eight original feeds.

The two additional batches published 3,618 listing-location records from 49
sources: 3,524 distinct application URLs, 3,611 vacancy-country pairs, 2,285 distinct
titles and 52 observed countries. `lever:21hhs` passed validation but timed out
in collection. It remains activated with durable backoff until
2026-10-30T02:35:42Z; no incomplete snapshot was published. Counts are observed
catalogue records, not claims of deduplicated employer requisitions, applicant
relevance, comprehensive country coverage or new vacancies since yesterday.

Across all 56 successfully published imported sources, hosted end-to-end checks
measured 4,731 listing-location records and 4,410 distinct application URLs across
52 countries. Generated exact-title profiles verified actual vacancies through
profile save, authenticated matching API and browser rendering for Ashby,
Greenhouse and Lever. No client errors occurred. Operator-state access and
customer source activation were denied. All three generated accounts were
deleted; no AI requests or employer applications were submitted. These profiles
verify integration, not recommendation quality for every profession.

`SOURCE_DISCOVERY_ENABLED=true` and `SOURCE_DISCOVERY_BATCH_SIZE=10` are enabled
on the isolated staging project's stable deployment. A live authenticated endpoint
request confirmed the expansion control path and skipped another batch during
its one-hour cooldown. It reported the collection backoff explicitly rather than
claiming complete success. The existing six-hour schedule is unchanged. Its next
scheduled invocation of this new expansion code has not yet been observed.
The runner's due-source continuation fix and ten-call bound are published as
`38cc1027e88aa9888b97008340063f4303c142e5` in the existing private repository, retaining its five-minute budget and error/backoff
stops. Other discovery feature code remains in this working tree and the staging
artifact. See [source discovery operations](../docs/source-discovery.md).

Verification passed: all 157 tests, lint, TypeScript and production builds locally
and on Vercel. Database tests cover candidate provenance/idempotency, operator-only
access, token-fenced leases, cooldown, interrupted-batch recovery, activation and
complete-snapshot publication. The runner regression covers a 65-source directory
requiring six twelve-source subsets, and bounded failure/lease/backoff behavior.

Private evidence is retained under ignored `.local-data/`:

- `discovery-expansion-1.json`, `discovery-expansion-2.json`
- `discovery-expansion-1-collected.json`, `discovery-expansion-2-collected.json`
- `discovery-additional-batches-inventory.json`
- `discovery-e2e-receipt.json`, `discovery-qa-{ashby,greenhouse,lever}.png`
- `discovery-hosted-trigger-final.json`, `discovery-status-expanded.json`
- `discovery-deploy-final.log`, `discovery-runner-published-final.json`

## Complete imported-candidate sweep (2026-10-30)

The fixed remaining-candidate manifest contained 13,303 IDs. The final database
audit verified that every ID has a live check result: 7,161 were activated,
1,341 were empty, 3,432 need review, 1,257 were missing and 112 were deferred.
Deferred checks are attempted but inconclusive; they are not passes. No freshly
verified candidate remained unactivated. Across all 13,383 imported candidates,
7,227 are activated, and every activated candidate has an enabled directory row.
The directory has 7,229 enabled canonical sources, including overlap with the
original sources. No non-passing candidate was automatically approved.

The inventory audit at 07:13:45 UTC measured 78,991 active listing-location
records, 71,334 distinct application URLs and 77,461 vacancy-country pairs from
3,338 published sources across 135 countries and territories. At that cutoff,
75,777 records had been checked within six hours. These counts are observed
inventory, not deduplicated employer requisitions, complete profession coverage
or a guarantee that every application destination will remain open.

The existing six-hour GitHub Actions schedule is unchanged. Its actual scheduled
dispatch [41010727666](https://github.com/v12labs-engineering/job-search/actions/runs/41010727666)
successfully started durable refresh `d2136ed9-4fac-4301-8d77-51a36fd9007d`.
That refresh published 1,652 source snapshots / 40,540 records before reaching
the 400 MiB catalogue admission budget. Those are run counters, not additional
unique vacancies. The final persisted state is `paused`, with committed source
snapshots retained. The measured database size was 410,121,907 bytes; admission
also reserves temporary staging and publication space, so a large source can
pause before the database's physical size reaches the budget.

The user explicitly chose to retain the current free tier. Billing and storage
limits were not changed. Source activation is independent of publication;
thousands of activated sources still await collection capacity. The refreshed
workflow prioritizes due published sources, oldest observation first, before
unmeasured growth. Resource and provider failures still limit freshness. Small
bounded refreshes remain possible within available headroom: a three-provider
pilot refreshed 58 real records after the capacity pause.

Migrations `202610300006`–`202610300015` were applied only to the isolated project
`zcaqbiejkvgqxsbrncty`. The staged collector has atomic storage reservations,
durable run/step accounting, queued snapshot writes, bounded transport requests,
and content-preserving updates for unchanged postings. A matching timeout exposed
by hosted verification was repaired by scanning complete listing metadata first
and loading descriptions only for relevant and saved jobs. The regression keeps
description-based scoring and complete coverage counts, including traversal when
the server returns smaller pages. The final reader uses the RLS-preserving
`catalog_matching_page` function, bounded to 5,000 metadata records per request,
with a country/ID index. JSON aggregation avoids the transport row cap while
keyset traversal still ends only on an empty page. The shared title gate precedes
full scoring, and matched-description reads use four concurrent batches of 100.
A broad generated US profile completed locally in 41.8 seconds with 2,406
matches; broad-profile latency remains a limitation of this free setup. The
listing scan is bounded to one minute and the authenticated state route to two.
A complete scan is required; timed-out scans do not return partial matches.

The latest staging artifact is
https://job-search-staging-aw5sp17s4-v12labs-projects.vercel.app, aliased to
https://job-search-staging.vercel.app. Its production build succeeded. This is a
CLI snapshot of the working tree; the broader feature changes are not committed
or pushed. The scheduler runner alone was published as
`87abf8d5fa09dd6365ae0a07d9d47936a16ff4dc`.

Private evidence: `.local-data/discovery-full-sweep.json` and its per-batch
receipts, `discovery-final-audit.json`, `discovery-final-pilot-refresh.json`,
`discovery-first-scheduled-durable-run.log`, and
`discovery-matching-final-deploy.log`. Local verification passed 164 tests, lint
and TypeScript. Hosted verification results are recorded separately below.

Final hosted verification passed at 07:47:48 UTC against the largest destination,
the United States: Ashby `coinflow`, Greenhouse `fashionnova` and Lever `ironflow`.
The three selected sources had 36 current records / 36 distinct application URLs.
All three generated exact-title profiles passed profile persistence,
authenticated matching, customer denial of operator discovery reads/activation,
actual vacancy-link rendering, and the employer source label in expanded job
details. No client errors were recorded. All three generated accounts were
deleted, with no AI calls or employer applications. The two interrupted helper
runs used outdated UI selectors; their tagged generated accounts were also
explicitly removed before the final run.

Evidence: `.local-data/discovery-final-us-e2e-receipt.json`,
`discovery-final-us-e2e.log`, and `discovery-final-us-{ashby,greenhouse,lever}.png`.
The helper now uses the current coverage region, pagination accessible name and
collapsed details control. Final deployment evidence is in
`discovery-matching-final-optimized-deploy.log`; migration 015 application is in
`discovery-matching-page-migration.log`. After the read index was added, the live
database measured 417,879,731 bytes; billing and the catalogue storage guard
remain unchanged. Passing this check verifies the integration and generated
profiles, not universal role relevance or low-latency performance.

## On-demand role/country search (2026-10-30)

The isolated staging artifact
https://job-search-staging-r7hxpha3c-v12labs-projects.vercel.app is READY and aliased
to https://job-search-staging.vercel.app. Migrations `202610300016` and
`202610300017` were applied only to `zcaqbiejkvgqxsbrncty`.
`ON_DEMAND_SEARCH_ENABLED=true` is enabled only in this staging project's
production environment slot. Billing, provider credentials and the 400 MiB
catalogue guard were not changed. The previous staging shell/application runtime
was retained; unrelated local navigation work was not rolled into this artifact.
The implementation remains in the working tree and CLI artifact; no feature
commit or push is implied.

**Find fresh jobs** uses saved roles/countries and an authenticated durable
request. Existing matches remain visible, shared scopes reuse work, progress
rehydrates after reload, and published snapshots trigger matching updates in the
background. The UI distinguishes publishing from a pending match update and
shows the next allowed request time. Admission is limited to three requests per
account per UTC day, 12 new shared runs per UTC day, one active run, and six small
boards per run. See [operations](../docs/on-demand-search.md) for complete caps,
scope selection, leases, privacy and retention.

The final live generated-profile test used **Software Engineer (Remote), India**.
Search `3f9ce676-98e6-4037-8c66-e4fe0c2ab084` completed a new shared run (not a
cached reuse) from 08:59:17 to 08:59:44 UTC. All six planned boards published
complete snapshots: nine fresh listing-location records. The browser received
one newly matching record automatically, increasing its real matches from 287
to 288. Nine fresh records includes refreshes; it does not mean nine new
vacancies. This is a generated exact-title integration check, not a general
recommendation-quality benchmark.

The hosted check also passed anonymous/forged-input/cross-origin denial,
customer denial of operator tables/dispatch, duplicate-request and equivalent
cross-account work reuse, existing-row continuity during search, browser reload
recovery and canonical saved-profile scope. No client errors occurred. Both
generated accounts were deleted. No AI call or employer application occurred.
The earlier small pilot independently published four records from three boards.

At the final check, database size was 418,223,795 bytes, below the unchanged
419,430,400-byte guard. Other requests can still pause when their snapshot
reservation cannot fit. A paused search preserves existing matches and shows
the free-limit reason; it never upgrades resources automatically.

Verification passed: 177 tests, lint, TypeScript, local production build and
hosted production build (26 compiled steps / four workflows). Postgres tests
cover ownership, normalized-scope reuse, quotas, dispatch recovery/fencing,
idempotent progress and expiry. Collection tests reject oversized/resumed/partial
snapshots and verify scoped requests avoid global metadata scans, including an
empty requested-source list.

Private evidence: `.local-data/on-demand-e2e-receipt.json`,
`on-demand-e2e.log`, `on-demand-live.png`, `on-demand-initial-e2e-receipt.json`,
`on-demand-all-tests.log`, `on-demand-final-contract-tests.log`,
`on-demand-release-deploy.log`, `on-demand-migration.log`, and
`on-demand-scoped-migration.log`.

## Resume contact autofill release (2026-10-30)

Deployment `dpl_BkgMzukU4yQjwN8n292x6qtsFasC` is READY and promoted to
https://job-search-staging.vercel.app. Its immutable URL is
https://job-search-staging-19g1etuc1-v12labs-projects.vercel.app. The source
snapshot preserves the Seoul (`icn1`) configuration from the intervening staging
release and changes only the five existing autofill runtime files plus the new
`lib/resume/contact.ts`. No database migration was required. This CLI release
does not imply a feature commit or push.

Automatic preparation now extracts unambiguous resume email, phone and public
profile links. PDF/DOCX import retains embedded contact hyperlinks. Existing
paused packets expose **Fill missing details from resume**, which persists only
blank identity/contact answers, preserves existing candidate answers and resume
edits, increments the revision and invalidates earlier approval. If a prior
import lost a hyperlink target, upload the original resume again before refilling.

Hosted Chrome verification at 10:09:36 UTC used a generated account and an
already-paused fictional packet. The button filled resume email (different from
the login email), phone and LinkedIn, preserved explicit name/salary answers,
and retained the filled values after reload. Anonymous, cross-origin and stale
revision requests were denied. No client errors, AI calls, workflow starts or
employer submissions occurred. The generated account was deleted. Existing
anonymous API/page authentication smoke checks also passed. These checks do not
claim a real employer submission.

Local verification passed 186 tests, lint, TypeScript and the production build;
the isolated release snapshot passed TypeScript and all 21 focused contact,
form-traversal, import and Postgres application tests. The hosted build passed.
Private evidence: `.local-data/autofill-release-snapshot.json`,
`autofill-final-deploy.log`, `autofill-live-receipt.json`, `autofill-live.png`,
and `autofill-auth-smoke.log`.

## Historical Boat browser provider (deployed 2026-10-30)

Historical evidence only: current source uses Browserbase with Stagehand. Remove
obsolete VM provider settings when deploying this change; the checks below do not
verify the replacement. See [current browser setup](../docs/application-browser.md).

Deployment `dpl_J61couJp7ACAqegAZ5zEBNXNYdEr` is READY and promoted to
https://job-search-staging.vercel.app. Its immutable URL is
https://job-search-staging-bsro6w4zk-v12labs-projects.vercel.app. The staging
project's production environment uses `APPLICATION_BROWSER_PROVIDER=boat` and
an owner-supplied `BOAT_API_KEY` stored as a sensitive server secret. The owner
activated the trial; this code performs no subscription purchase or wallet top-up.
The Seoul region and existing backend state remain in place. No migration was
required, and this CLI source deployment does not imply a commit or push.

Each attempt uses a fresh private `small` VM with no inherited account secrets,
no snapshots/monitoring and a five-minute auto-stop. Normal and failed attempts
request deletion, with stop as a cleanup fallback. The same form, public-network,
approval, claim and receipt checks remain in use. See
[operator configuration and verification](../docs/application-browser.md).

The real Boat browser check passed public navigation, generated email/phone/
LinkedIn filling, PDF upload, untouched optional consent and synthetic
confirmation. Its VM deletion was confirmed by a subsequent 404. The provider
startup tests cover Boat's actual HTTP 400 ENOENT readiness response and the
Playwright method receiver required by the production connector.

The final hosted automatic-continuation run
`881bb079-af8a-4808-920f-05af062d8669` passed at 17:03:25 UTC. It used a generated
3,530-character resume, actual configured-model tailoring and Boat browser
sessions. Required-answer gating, stale revisions, cross-account read/edit/
approve denial, RLS isolation and duplicate approval rejection passed. The
synthetic receiver verified approved answers and PDF text and recorded exactly
one submission. The application receipt and Applied tracker state were verified.
Both generated accounts were deleted; a final Boat read found zero active
application sandboxes. No real employer was contacted. The paused-application
UI also passed fill-from-resume, preservation of candidate edits and reload
persistence during the rollout. Anonymous-access smoke checks passed.

The first hosted test exposed an outdated DOCX-only synthetic receiver and was
correctly marked `submission_unknown`; that run was never retried. The receiver
now accepts the actual PDF, compares it with the approved rendered resume and
retains legacy DOCX checks. Continuation now accepts the existing bounded resume
payload instead of rejecting normal resumes at 2 KB. The live site was returned
to its prior deployment while the fixture repair was tested and rebuilt.

Verification passed: 199 tests, TypeScript, changed-file lint, isolated local
production build and final hosted production build. Private evidence:
`.local-data/boat-integration-readiness.json`, `boat-live-browser-receipt.json`,
`boat-release-snapshot.json`, `boat-final-deploy.log`,
`boat-final-hosted-application.log`, `application-runner-verification-automatic.json`,
`boat-final-auth-smoke.log` and `boat-existing-application-ui.log`. Keys and signed
browser-control URLs are excluded from these receipts.

## Historical refresh diagnosis, storage recovery and Boat collection (2026-10-31)

Historical evidence only: current collectors use direct HTTP. The VM worker,
its SDK, configuration and verification scripts have been removed.

Deployment `dpl_B1Wxxuvez5KGLp2WEx7v9KEsYjgR` is READY and assigned to
https://job-search-staging.vercel.app. Its immutable URL is
https://job-search-staging-5t9amnc6t-v12labs-projects.vercel.app. The prior deployed
source tree matched the workspace outside this change. No migration, billing
change, storage-budget increase, commit or push was performed.

The old refresh icon only reloaded stored matches. Scheduled collection was also
paused: database size was 419,649,203 bytes against the unchanged 419,430,400-byte
guard. The source-health audit found 7,229 enabled sources, 3,343 with a successful
publication, and none successfully checked in the preceding six hours.

A lossless `VACUUM (FULL, ANALYZE, SKIP_LOCKED)` of only `job_catalog_run_items`
recovered 8,830,976 bytes. All 1,364 staged rows retained the same row hash/count;
no snapshot, listing, source, account or application history was deleted. Database
size afterward was 410,818,227 bytes. This is limited recovered headroom, not a
permanent capacity expansion.

**Refresh jobs** now names the primary collection action. The icon is explicitly
**Reload saved matches**. Admission reports full storage before spending search
quota, including accounts without an earlier search. Eligible-board selection
now reaches up to 24 boards while retaining the existing source-size, time,
concurrency and request quotas. Large sources can still exceed these limits.

The optional Boat feed worker was live-verified across Ashby, Greenhouse and
Lever with deletion confirmed afterward. A separate single-VM collection pilot
published complete snapshots from 12 previously uncollected, already-verified
boards: 19 new catalogue records / 19 distinct application URLs across Cyprus,
Czechia, Germany, India and the United States. These are newly collected records,
not claims of jobs posted today or matches for a particular applicant. A final
provider audit found zero active catalogue workers. Automated collection retains
the default direct fetch provider; Boat can be selected explicitly with the
operator command or `CATALOG_FETCH_PROVIDER` after checking existing allowances.

Local browser/API verification used a generated account and a lower local-only
storage guard. It confirmed the storage message, disabled collection, zero
admitted requests and working reload of 288 real matches. No database guard was
changed. The final hosted generated-profile check used Customer Success Manager,
India. Its new durable run `9048898f-5edc-478f-85c6-863b02fea39d` processed all nine
eligible boards, published eight snapshots / 62 observed records, and correctly
reported partial completion because one board exceeded the bounded source limit.
Published observations arrived automatically, progress survived reload, duplicate
and equivalent requests reused work, and authorization checks passed. That profile
had eight matches before and after; zero newly matching records were observed.
Both generated accounts were deleted. No AI request or employer submission occurred.

Verification passed: lint (two pre-existing warnings in ignored local helpers),
TypeScript, all 228 tests, local production builds and the final hosted build.
Private evidence: `catalog-before-compaction-20261031.json`,
`catalog-staging-{before,after}-compaction-20261031.json`,
`boat-catalog-pilot-{result,audit}.json`, `catalog-boat-verification.json`,
`refresh-capacity-verification.json`, `refresh-final-{lint,tests,types}.log`,
`refresh-release-deploy-final.log`, `refresh-hosted-e2e.log`, and
`on-demand-e2e-receipt.json`, all under ignored `.local-data/`.


## 2026-10-31: free storage recovery and wider profile discovery

Migrations `202610310005` through `202610310010` are applied in the isolated
staging project. The reader-compatible release is
`dpl_82tLsfFBbckxpzQSkE1P9JAbQ5xg`, aliased to the staging app.
All 79,174 catalogue descriptions were losslessly archived to verified immutable
Brotli packs in the existing free object bucket. The final integrity audit found
zero raw descriptions and zero broken references, with row counts preserved.
Object bytes: 168,935,770. The original saved-profile match objects remained
identical: 296 candidate records, 68 reviewable, zero strict eligible.

Bulk attachment exposed statement timeouts. The final migration pins each
compare-and-swap to an indexed ID lookup; the helper keeps efficient pack uploads
while attaching in 16-row transactions with bounded timeout retries. Ordinary
vacuum left a sparse TOAST heap allocated. A direct live-chunk check found zero
rows, despite stale estimated statistics. PostgreSQL 17's
`VACUUM (FULL, PROCESS_MAIN false, SKIP_LOCKED) public.job_catalog` compacted only
that empty TOAST relation: database bytes fell from 446,592,691 to 180,999,859,
and TOAST bytes to 8,192. No quota, paid plan or 400 MiB collection guard changed.

The native hosted Refresh jobs flow then ran the confirmed account's coarse
Lead Software Engineer / India scope on Boat. Temporary fictional accounts held
only the saved role/country/location scope, never the person's resume or identity.
The actual account reused this identical shared run through normal admission.
Run `209118b8-1246-401f-a796-98cf6a432c21` processed all 96 planned boards in
approximately 4m18s: 91 published, five failed, 97 observed records, 32 new IDs.
Status correctly reports partial. Existing listings were not expired by scoped
observations. Browser matching arrived automatically, progress survived reload,
equivalent requests reused work, and authorization checks passed. Both QA
accounts were deleted; no AI call or employer application occurred.

The actual account finished with 327 candidate records and 77 reviewable matches.
Nine reviewable listings were absent from both baseline IDs and URLs and first
seen during this run. Two Protolabs Hyderabad postings are dated October 30;
seven other new discoveries have older source dates. None becomes a strict
eligible match merely because it was discovered. The UI labels old postings,
sorts by first discovery by default, and offers Show 9 new matches. A repeated
URL's older discovery time prevents a new variant from inflating that counter.

All 235 tests, TypeScript, final builds and lint passed (two existing warnings in
ignored benchmark helpers). Private receipts include
`catalog-archive-final-audit.json`, `catalog-storage-recovered.json`,
`catalog-toast-before-compaction.json`, `profile-after-archive.json`,
`profile-discovery-outcome.json`, `own-wide-search-admission.json`,
`on-demand-e2e-receipt.json`, `profile-wide-hosted-e2e.log`,
`storage-wide-final-{tests,types,lint,deploy}.log`, and `on-demand-live.png` under
ignored `.local-data/`. Profile-derived receipts stay local and are not shipped.

## Third-step onboarding timeout (2026-10-31)

Vercel confirmed profile saves returned 200, followed by `/api/state` failures
with PostgreSQL `57014` from `catalog_matching_batch`. The generic plan scanned
the global primary key and filtered countries/cursors afterward. Migrations
`202610310012_matching_query_plan.sql` and
`202610310013_matching_indexed_keys.sql` are applied to isolated staging.
The reader now plans with bound parameters, selects bounded IDs using a covering
country/cursor index, and loads metadata through bounded primary-key lookups.
The existing RPC signature, snapshot filters, continuation and invoker RLS remain.
No profile, resume, listing or application data was removed.

Safe diagnostics in `http.ts` and `session.ts` log database codes and failed
operation names/statuses without messages, query strings, headers or payloads.
They are live in deployment `dpl_3HzrLvqG7HbSMyxfwXgu9fWTu6gy` at the staging alias.
The separate precomputed-matching work was excluded from this release. Its
in-progress earlier migration `202610310011_precomputed_matches.sql` will need
an explicitly reviewed `--include-all` rollout because 012 and 013 are applied.

The final hosted Chrome check used a temporary fictional account: text resume
upload, actual AI analysis, review, eight destinations, profile save, first
matches and reload all passed, with no browser errors. The first matching load
took 63 seconds; this fix does not claim instant catalogue-wide matching.
Profile/resume/destinations persisted after reload. The generated account was
deleted. No employer submission occurred. All 235 tests in the isolated release,
focused pagination/RLS/logging checks, TypeScript, lint and hosted builds passed.
Private evidence: `.local-data/onboarding-browser-receipt.json`,
`onboarding-browser-indexed.log`, `onboarding-fixed-browser.png`,
`onboarding-indexed-query-plan.log`, `onboarding-final-isolated-tests.log`, and
`onboarding-{indexed-migration-apply,diagnostic-deploy-operations}.log`.


## Open-source matching worker rollout, 2026-10-31

The protected `job-search-matching-staging` container worker and staging app are
connected in Seoul using application authentication plus a production-to-production
Vercel Trusted Sources rule. Matching migrations 018–020 are applied and policy
`oss-2026-10-31-v1` is active. The worker has since been retired; migration 030
resets the policy to `legacy-v1` and the app uses the in-app rule scorer.

Hosted acceptance used 45 real Danish listings with a generated QA account:
three published relevant matches, 68 source quotes checked, denied direct cache
access, zero application runs and a browser check with no page errors. Live
collection continued invalidating later generations; a published OSS generation
remained readable. The generated account can be removed using the acceptance
helper's `--cleanup` option. No private production database or hosting plan was
changed. The test does not establish match quality across all countries.


## Vercel-only scheduled collection — 2026-11-02

The current scheduler configuration supersedes the historical GitHub collection
setup above. `vercel.json` now targets `/api/cron/jobs` every six hours at 00:00, 06:00,
12:00 and 18:00 UTC. The owning Vercel team has an active Pro plan. The
GitHub collection workflow is removed; CI remains. The endpoint requires the
existing Vercel `CRON_SECRET` and always starts/reuses a durable Vercel Workflow.
Maintenance and optional source expansion execute inside that workflow before
collection. Supabase remains the existing data/checkpoint store.

These are repository changes, not evidence of deployment or an observed cron run.
Apply all required migrations, deploy through the existing Git integration,
verify the Cron Jobs path and follow a manual invocation to persisted source
results before observing the next scheduled invocation. See
[catalogue operations](../docs/catalog-operations.md#scheduling-and-recovery).


### Deployed and manually verified — 2026-11-02

Vercel deployment `dpl_7CmekCXPwg9UGdMN28gPdtUxUqCA` is READY and promoted to
<https://job-search-chi-amber.vercel.app>. It was deployed directly from the tested
local checkout, including uncommitted work; its displayed Git SHA describes the
base commit, not the complete uploaded source. Local lint, typecheck, production
build/bundle checks and all 326 tests passed. Deployed sign-in returned HTTP 200;
the dedicated cron rejected an unauthenticated request with HTTP 401.

The live project cron definitions confirm `/api/cron/jobs` uses `0 */6 * * *`.
The old GitHub `Collect job catalogue` workflow is `disabled_manually`, with no
active run observed at cutover. The separate application sweep remains daily.
Scheduled collection refreshes matching but does not launch application submission.

One authenticated manual GET at 04:28 UTC returned HTTP 202 and refresh
`71c174c6-ed44-4d63-a06f-9e94dd0e47c4`, workflow
`wrun_41M6D88B7NAGGVNMN71GGRBGJA`. At the 04:30 UTC evidence snapshot, 47 source
runs had completed, reporting 9,335 fetched postings, 176 new listing records,
1,604 content updates and 352 expirations. Fresh catalogue rows were read back
from `lever:ajax`. The catalogue had 57,753 records after 167 protected-rule cleanup
deletions and the 176 additions, compared with 57,744 at baseline. Accepted counts
include listing-location variants and are not unique global vacancies.

The full 7,229-source cycle was still running at that snapshot; completion of all
sources and later automatic six-hour delivery have not been claimed. No runtime
errors or warnings were returned by the deployment-scoped scan through 04:30 UTC.
The private receipt is `.local-data/vercel-cron-verification.json`; verification
credentials were never stored in it. No plan or budget upgrade was made.
