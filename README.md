# Job-search product

A Next.js application being expanded from a private relocation tracker into a
public product. The current implementation provides account isolation,
onboarding, personalized matching and source-grounded resume drafts. Billing
and public deployment remain release gates; this is not yet a paid launch.

## Stack

- Next.js App Router, React, TypeScript, Tailwind and local shadcn components.
- Supabase Auth with cookie sessions via `@supabase/ssr`.
- Postgres with row-level security for every account-owned table.
- AI SDK with structured output and an explicit OpenAI-compatible provider.
- PDF/DOCX/text import and DOCX export. Original uploads are not persisted.
- PGlite for executable Postgres migration and RLS integration tests.

## Local setup

1. Use Node.js 24 and run `npm ci`.
2. Copy `.env.example` to `.env.local` and configure a development Supabase project.
3. Apply migrations in `supabase/migrations/` in order to that development project.
   Do not apply the new migration blindly to the existing private production DB.
4. Enable email authentication, configure SMTP and allow
   `http://localhost:3002/auth/callback` as a redirect URL. Local Supabase uses
   the same port via `supabase/config.toml` (requires a running Docker daemon).
5. Run `npm run dev` and open <http://localhost:3002/sign-in>.
6. Sign in, upload your resume, review your profile and find jobs in India.
   Apply `202611180092_india_job_search.sql` before releasing these screens to
   move existing profiles to India and rebuild their matches. The migration
   preserves saved jobs and application history.

Search preferences can include up to five Indian cities or towns.
Suggestions use Open-Meteo's country-filtered geocoding API
(GeoNames data); queries require sign-in and are debounced. The public endpoint
is for non-commercial use; review its usage terms before a paid launch.
Locations are saved in the existing private profile JSON, so no additional
migration is needed for locations. Leaving locations empty searches all of
India. A different stated city is excluded from new recommendations; a missing
city stays reviewable with a warning and cannot count as a strict fit. A city
name without the selected regional detail also needs confirmation.

The new `202610290001_public_accounts.sql` migration preserves legacy data but
revokes public-account access to it. It publishes only listing facts into
`job_catalog`. Existing personal statuses, notes and resumes are never assigned
to signups. Back up the database and verify the migration in staging first.

## Ownership and authorization

Profile, job-status and resume routes use verified Supabase identities and
user-scoped clients with RLS. The on-demand search route uses the user's client
to admit/read an owned request, then a server-only operator client to dispatch
bounded shared collection. Profiles, search preferences, job
states, resume drafts and daily AI usage belong to the authenticated user.
Shared listings are read-only for customers. Signing out clears the local session.

`/api/sources/collect` is an operator-only ingestion endpoint requiring
`Authorization: Bearer <INGESTION_SECRET>` and the server-only service-role key.
Its request awaits collection; **Reload saved matches** only reloads stored matches.
**Refresh jobs** starts an authenticated background search in India using saved
roles and city preferences, while existing matches remain visible. Scoped discovery uses
direct public-feed requests to explore up to 96 verified boards, prioritizes unseen listings and shows
new profile matches separately from refreshed observations. Public descriptions
are stored losslessly in the existing free object bucket; searchable metadata
stays in Postgres. Apply `202610310005` through `202610310010` and deploy reference
readers before running the description backfill. The shared
catalogue collector now checkpoints pages in Postgres, fences workers with lease
tokens, and publishes complete source snapshots atomically. Apply the additive
`202610290006_catalog_collection.sql` and `202610290007_catalog_backoff.sql`
migrations before releasing the new collector. Do not expose operator secrets
to browser code. See [catalogue operations](docs/catalog-operations.md).

## Matching and tailoring

Source connections share the registry in `lib/server/catalog/connectors`.
`fetchSourcePage` exposes source facts across professions; `fetchCatalogPage`
keeps the current product's software policy. Research adapters use the same
provider readers. See [source connector architecture](docs/source-connector-architecture.md)
for the implemented boundary, how to add a source, and remaining storage work.

Matching is an in-app rule scorer (`lib/matching/index.ts`). Your preferences are hard
filters: India and any preferred cities, excluded companies, work mode (a "remote"
posting that asks for office days counts as hybrid), an experience band around your
years, and postings that refuse sponsorship where you need it. The 0–100 score only
ranks what passes: title match (35, related 30), listed skills (45), work
authorization or a confirmed sponsor (10) and experience closeness (10). Before
an automatic application is sent, the tailoring call also checks the resume against
the posting's explicitly required qualifications. Gaps are advisory; the resume
never invents qualifications, and required employer questions need grounded answers.

The Jobs page reads precomputed account scores with server pagination. Apply
`202610310011_precomputed_matches.sql`, `202610310014_cached_matching_query_plan.sql`
and `202610310015_match_posting_window.sql` before deploying this reader. Jobs
defaults to postings from the past week, with an explicit Past month option and
newest posting dates first. Saved and applied jobs remain available regardless
of age; unknown posting dates are excluded from new discovery. Profile saves
and catalogue refreshes enqueue durable scoring; completed results stay visible
during catalogue updates. A first build or profile change shows progress while
the page polls. See [precomputed matching](docs/precomputed-matches.md) for the API
contract, backfill endpoint, migration ordering and failure recovery.

Apply `202610310016_catalog_retention.sql` before deploying catalogue cleanup.
Apply `202610310017_catalog_revision_safe_update.sql` for its hosted trigger guard.
Scheduled collection first deletes unprotected listings older than 30 days in
bounded batches and reclaims whole unused description packs. Saved/applied jobs,
resume drafts and all application records are protected across accounts. Undated
listings are retained. See [retention operations](docs/catalog-retention.md).

Matching reads source-health summaries in one database request, with complete
health details scoped to India. Apply
`202610300019_matching_overview.sql` and
`202610300020_matching_batch_continuation.sql` before deploying this reader.
Explicit batch continuation avoids a final empty request for each destination. Vercel functions
run in Seoul (`icn1`), alongside the staging Supabase database, to avoid repeated
cross-region database round trips. Matching reads live account statuses and listing availability on each page request;
the catalogue scan and description scoring run in the background.

Background matching scans current listings in a user's target countries using stable ID
pagination, plus up to 1,000 recently saved job states. An exceeded worker budget
retains the last complete generation and reports a matching failure rather than
silently dropping results beyond 3,000 rows.
It explains country, role, listed
skills, work mode and sponsorship evidence. This is an evidence score, not a
prediction of interview success. Missing descriptions and posting dates remain
unknown. An employer register entry is not treated as a role-level visa promise.

Scheduled collection supports software engineering, data and analytics, product
management, design and user research, marketing, sales and business development,
customer success, and technical support. Each user selects one or more categories
in Profile or Preferences. Existing profiles default to software; importing a
new resume preserves the user's category choices. Category selection is a hard
matching filter alongside target roles, experience and locations. Categories
describe the work, not an inferred employer industry.

The shared category vocabulary and policy live in `lib/jobs/categories.ts`.
Software classification retains `lib/jobs/software-roles.ts`, including description
evidence for ambiguous titles such as CTO. Direct provider-reader calls keep
their software default unless `FetchOptions.jobCategories` is supplied;
scheduled collection requests all supported categories. Source-fact readers
retain every profession before this policy. Unrecognized titles are excluded;
comprehensive occupation aliases and cross-language translation remain gaps.

Apply `202611170078_profile_job_categories.sql` before releasing the category
controls. It updates compact match reads and discovery priority, fences old
workers, and invalidates cached classifications while preserving saved and
applied history. Scores from an older profile version cannot supply new-job
results while the user's changed category selection is rebuilding.

Listing variants retain their country and city through matching and deduplication.

Coverage comes from configured employer feeds and job boards, including New
Relic and Deliveroo's public Greenhouse boards for India/Hyderabad coverage.
Choosing a city filters this catalogue. On-demand search prioritizes observed role/country
evidence from verified boards and performs bounded country-based exploration;
it does not search the entire web. Greenhouse multi-city postings retain separate location
variants, and duplicate removal prefers the variant the applicant can review.
India coverage counts use listings in the active search market.
Coverage distinguishes missing source assignments, unmeasured, partial, failed,
stale and checked-empty sources. It reports candidate-relevant supply separately
from catalogue volume and separates confirmed from unknown sponsorship.

`npm run catalog:audit -- --staging` measures the isolated staging catalogue across
all 249 selectable countries and territories. `npm run catalog:collect -- --staging`
collects the enabled operator source directory. Imported employer-board links
remain inactive until live validation passes; bounded staging expansion can then
activate them automatically. See [employer source discovery](docs/source-discovery.md)
for pinned directories, validation policy, batch controls and verification. Vercel Cron is the sole scheduled collector: `/api/cron/jobs` starts or reuses a
durable Vercel Workflow every six hours at 00:00, 06:00, 12:00 and 18:00 UTC
(05:30, 11:30, 17:30 and 23:30 IST), with cleanup, optional source expansion and
checkpointed feed scraping in background steps. The verified Vercel team uses
an active Pro plan, which supports this cadence.
Configure a server-only `CRON_SECRET` on Vercel and apply the durable-refresh and
retention migrations before deploying. HTTP 202 means accepted, not completed;
follow `catalog_refresh_runs` and `job_catalog_runs` for actual results. GitHub
Actions runs CI only. The existing Supabase storage is unchanged. See
[catalogue operations](docs/catalog-operations.md#scheduling-and-recovery) for
cutover, retry and deployment verification. Source 429 responses persist their retry time and page
cursor for a later attempt.

Employer discovery also accepts bounded career-page link scans, and the catalogue
supports SmartRecruiters public Posting API reads and Workday career-site JSON
reads. Apply migrations `202611010035` and `202611010036` before importing these
source families. Run `npm run catalog:discover -- links --file
scripts/catalog/employer-career-seeds.txt` for a read-only example; validation, activation
and publication remain separate. Workday boards at the 2,000-result cap fail
explicitly until partitioned scans are supported. See the
[extended-source operations](docs/source-discovery.md#employer-career-links-and-additional-ats-readers).

An operator can use `npm run catalog:discover-worldwide -- --staging --batch 0
--browserbase-env .env.local --output .local-data/browserbase-worldwide-0.json`
to discover additional source candidates. Twenty-one explicit batches cover all
249 selectable countries and territories; each query gets a bounded share of the
URL budget. Search scope does not establish available jobs in a country.
Browser sessions are opt-in; the default uses bounded Search and static career-page
reads. Import, live validation, activation and complete collection remain separate. See
[Browserbase discovery operations](docs/browserbase-discovery.md) for usage limits,
private receipts, verification and measured pilot results.

With migration `202611040050` and `AUTOMATIC_DISCOVERY_ENABLED=true`, the existing
six-hour workflow also discovers new boards automatically on isolated staging.
Each run balances underserved user destinations with worldwide country rotation;
the database caps automatic usage at 48 Search requests and $1 reserved per UTC
day. Browsers stay off. Live identity and recent software-posting checks precede
activation; complete collection still precedes publication. See the
[automatic discovery controls](docs/browserbase-discovery.md#automatic-worldwide-discovery).

LinkedIn public job-search and detail HTML can also be collected with
`npm run catalog:linkedin -- --keywords 'Software Engineer' --country IN`.
This defaults to a read-only preview. Migration `202611010037` is required before
deploying the updated readers; validated `--staging --apply` registration enables
later scheduled collection. LinkedIn search windows never expire unseen jobs.
See [LinkedIn collection](docs/source-discovery.md#linkedin-public-jobs-collection)
for query limits, backoff and the separate registration/publication steps.

Enable `ON_DEMAND_SEARCH_ENABLED=true` only after applying additive migration
`202610300016_on_demand_job_search.sql` and
`202610300017_scoped_catalog_collection.sql`. New shared searches are limited to 12
per UTC day, one active run, up to 24 small boards per run, and three requests per
account per UTC day with a one-hour cooldown. Equivalent role/country scopes
reuse work for one hour. Runs, progress, quotas and ownership are persisted in
Postgres. Polling reconnects after reload and refreshes matching results after
publication. Complete-snapshot, provider-backoff and storage-reservation guards
still apply. Refresh jobs uses direct career-board collection. See
[on-demand operations](docs/on-demand-search.md).

On a confirmed application, **Find people to contact** suggests recruiters and
other employees with public LinkedIn profiles. Apply
`202611110068_application_followup.sql` and set `FIRECRAWL_API_KEY` on the server
to enable contact lookup through Firecrawl Alexandria. See
[application follow-up](docs/application-pipeline.md#application-follow-up).

Resume tailoring requires `TAILORING_BASE_URL`, `TAILORING_API_KEY` and
`TAILORING_MODEL`. Production endpoints must use HTTPS. A user explicitly
requests tailoring after seeing the provider-disclosure notice. The
[resume preparation skill](skills/resume-preparation/SKILL.md) extracts keywords
from the posting and checks them against the source and final resume. The draft
keeps one copy of the resume and prioritizes existing bullets within their
lists. Review the keyword coverage and gaps alongside the editable draft and
its PDF preview. Automatic preparation below 80% or without a score pauses for
manual review. Drafts can be exported as PDF or DOCX.

Ten provider attempts per account per UTC day are reserved atomically in Postgres.
Failures count to limit abuse. No successful draft is recorded when the provider
or database fails. Resume import accepts PDF, DOCX and UTF-8 text up to 2 MB;
scanned PDFs need a text version. Review extracted text before saving.

## Automatic applications

**Tailor & apply** adds jobs to a durable per-account queue and keeps the job list
open. Applications distinguishes **In queue** from **In flight**. One job proceeds
through preparation and sending at a time; jobs needing missing information pause
while the next job proceeds. Saving the final answer continues automatically,
without another approval. OTPs use the existing Telegram connection and browser
session. Automatic runs never ask users to operate form controls or solve CAPTCHA;
exhausted recovery is reported as a failed or unconfirmed attempt. Apply
`202611060056_continuous_automatic_applications.sql` after the earlier migrations.
Apply `202611030045_application_queue.sql` before
deploying the queue-aware workers and list. See the
[application pipeline guide](docs/application-pipeline.md#account-application-queue).

Automatic application details show named task progress, attempts, safe failure
reasons and scheduled retries. Preparation checkpoints survive worker recovery;
an unverifiable automatic send gets one extra attempt, then offers **Try again**.
Apply `202611080064_automatic_unconfirmed_retry.sql` before deploying this policy.
It applies to new send outcomes and does not resend historical attempts.
Apply additive migration
`202611010034_application_tasks.sql` before deploying this version. See the
[application pipeline guide](docs/application-pipeline.md) for stages, retry policy
and recovery requirements.

Onboarding includes an optional reusable application profile for confirmed
contacts, country-specific work eligibility, availability and salary expectations.
The runner uses these facts across differently worded common questions and later
form pages. Opt-in written answers assemble verified resume passages and the
candidate's stated career interests with role evidence; missing facts still pause.
Preferences can fill waiting packets together and continue complete automatic
applications. Apply `202611010032_application_profile_reuse_overrides.sql` for
profile answering and `202611190097_remove_application_daily_limit.sql` to
remove the saved daily cap from application admission. See the
[application profile and verification guide](docs/application-profile.md).

Every active listing with a public HTTPS URL exposes **Tailor & apply**. The
application action does not depend on an ATS vendor or employer-domain allowlist.
Closed listings and invalid/private destinations show a disabled action with a
reason. **Mark as applied** remains a self-reported tracker action.

Clicking Tailor & apply requests tailoring and sending to the selected employer
through the configured AI provider and an isolated cloud browser. After tailoring,
Browser Use finds and fills the live form in one session, using saved candidate
facts and the approved PDF. Manual preparation retains separate read-only discovery.
The backend validates ownership, quotas and saved answers, records intent before
sending and verifies the employer's receipt before reporting success.

The runner selects source-backed resume passages, copies confirmed identity and
public links, and uses native browser tools for controls and multi-page forms.
Missing required answers are saved in the private packet and
requested inside this app. Save & continue saves answers and resumes in one
action. Salary, immigration status, demographics and consent are never guessed.
In-app alerts link to applications with unanswered required questions. New
questions and candidate answers are kept in a private **Saved answers** library;
new answers default to reuse across employers when saved or continued. Each
answer can be limited to one employer or set to ask again. Consent and
declarations still require confirmation per application. Apply
`202611040048_application_answer_reuse_defaults.sql` before deploying this default.
See [question memory and notifications](docs/application-questions.md).
An optional Telegram channel can also deliver missing questions and accept exact
answer edits. Automatic applications continue after their last answer; manual
applications retain revision-bound approval. Employer OTPs require a connected
Telegram account. It uses the existing Supabase connection and a BotFather token,
with migration `202611020038` and the later verification migrations.
See [Telegram setup and verification](docs/telegram-notifications.md).
Site-independent discovery does not guarantee completion on every website:
login/OTP, CAPTCHA, unknown controls, employer restrictions and unavailable
services can pause a run. Never report a submission without an employer receipt.

Postgres retains the automatic instruction across missing-answer pauses and edits.
Edits invalidate the frozen packet; continuation freezes the new revision atomically.
Cancellation prevents automatic continuation. New unverifiable automatic sends
retry once after a 15-second delay; another unverifiable result offers **Try again**.
Service-only claims prevent concurrent sends to the same employer, independently
of its hosting platform. Repeated requests for a saved job reuse its application
even when the catalogue URL changes. The automatic retry allowance persists
across restarts, answer edits and explicit retries. Legacy review-first
applications retain explicit approval.

Every extra AI navigation decision reserves an attempt from the shared monthly
account allowance. Decisions are bounded per packet version, per discovery
call and by the overall browser navigation budget. URL syntax, public-address DNS
checks and Chromium request interception guard destinations, redirects and
subresources. Service-worker bypass prevents requests avoiding interception.
Hosted network isolation and real employer flows still require staging acceptance.

Apply `202610300001_automatic_applications.sql` followed by
`202610300002_site_independent_applications.sql` before serving this version.
The configured provider hosts each isolated application browser. The open-source Python
Browser Use SDK owns navigation, DOM inspection, typing, dropdown selection,
file uploads and submission. It retrieves saved candidate answers through a
business tool and delegates visible CAPTCHA challenges to 2Captcha. There is
no Stagehand dependency or field-by-field backend filling loop in production.
The backend owns account authorization, approved resume files, decision quotas,
durable submission intent and verified receipt persistence.

For Boat, configure `APPLICATION_BROWSER_PROVIDER=boat`, `BOAT_API_KEY` and
`TWOCAPTCHA_API_KEY`. The explicit Browserbase rollback path uses
`BROWSER_USE_WORKER_URL`, `BROWSER_USE_WORKER_TOKEN`, `BROWSERBASE_API_KEY` and
`BROWSERBASE_PROJECT_ID`.
`BROWSER_USE_MODEL` selects the DOM-only planner independently of resume tailoring;
when empty it inherits `TAILORING_MODEL`. See [worker setup](workers/browser-use/README.md)
and [runtime responsibilities](docs/application-browser.md). Sessions are released
after use, with provider-specific timeout backstops.

## Verification

```sh
npm run lint
npm run typecheck
npm test
npm run build
npm audit --omit=dev
# With the configured production server running locally:
npm run smoke:auth
```

Tests execute the RLS migration in an isolated Postgres engine with anonymous and
two authenticated roles, including cross-user reads/writes, forged ownership,
transaction rollback and independent daily quotas. They also cover validation,
matching, grounded tailoring, request limits and resume import.

See [the release plan](docs/production-release.md) for remaining staging, billing,
abuse-control, privacy and operational launch requirements. The original
`MVP_SPEC.md` describes the historical private app and is superseded by that plan.

## Deployment workflow

`npm run build` also audits the generated function dependency traces. Builds fail
if a trace includes `.local-data`, `.git` or environment files, has missing runtime
files, or exceeds 50 MiB uncompressed. Run `npm run check:function-bundles` to
inspect an existing build. These trace sizes are a packaging check, not Vercel
billing measurements. Collection PDF parsing uses isolated temporary directories;
developer datasets and model environments must stay outside deployed functions.

Commit verified changes and push them to `main`. The existing
`job-search` Vercel project is connected to this GitHub repository with
`main` as its production branch. Let the Git integration build and deploy that
commit, then verify the deployment before reporting it live. Use a direct CLI
deployment only when explicitly requested. Keep credentials and local test data
in their existing ignored files.
