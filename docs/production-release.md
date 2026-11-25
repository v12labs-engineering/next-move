# Public product release

This supersedes the private, single-user scope in MVP_SPEC.md and the June simplification plan.

## Architecture

Keep Next.js App Router, TypeScript, React and shadcn. Use Supabase Auth via
@supabase/ssr and Postgres RLS. User requests use the publishable key and the
verified user's cookie session; service-role access is restricted to ingestion
and the approved application runner.
Job listings are shared, while candidate profiles, country choices, job statuses
and generated documents belong to a user. Existing private records are preserved
but locked away from public accounts; they are never automatically assigned to
new signups. Do not rewrite previously applied migrations.

Matching is deterministic and explainable against user preferences and available
listing evidence. Missing job descriptions are explicitly reported. AI SDK handles
bounded structured generation with a server-configured provider. Resume tailoring
selects verbatim evidence from the candidate's source resume; it cannot invent
experience, metrics, employers or qualifications. Drafts require user review.

Ingestion is an operator-only workload, independent of customer page requests.
No fire-and-forget scrape work is triggered by onboarding. A durable scheduler/
worker and paid billing are separate launch gates, not simulated as completed.

## Implementation sequence and verification

1. Cookie auth, server page/API checks, additive RLS migration. Execute migration
   against an isolated Postgres engine and test anonymous access, two independent
   users, forged ownership, direct writes, and cross-user document access.
2. Validated onboarding, editable profile, country preferences and resume import.
   Test incomplete/oversized/malformed submissions, unsafe redirects and refresh.
3. Per-user matching with reasons and missing-evidence warnings. Test different
   candidate profiles, visa requirements, exclusions and stable ranking.
4. Resume tailoring, persisted history and document export. Test ungrounded AI
   output, duplicates, timeouts, quotas and ownership. AI/provider failures must
   leave no completed draft or fabricated result.
5. Run lint, typecheck, unit/integration tests and production build. Verify the
   browser -> API -> database path locally. Record unavailable external checks.

## Public launch gates

- Apply reviewed migrations to a staging Supabase project, then validate real
  signup, email delivery, cookie refresh, signout, account deletion and isolation.
- Configure authenticated SMTP, redirect allowlist, CAPTCHA and abuse controls.
- Add hosted billing checkout/portal, verified idempotent webhooks, entitlements,
  cancellation and a usage ledger before charging customers.
- Set deployment-owned AI credentials/model; do not depend on a developer's
  localhost proxy. Validate provider privacy/retention and bound spend.
- Run ingestion in a durable worker, validate source licenses, job freshness and
  genuine role-level sponsorship evidence. Add alerts, backups and recovery drill.
- Publish accurate pricing, terms, privacy, retention and deletion policies.

No production migration or deployment is implied by passing local checks.

## Local verification on 2026-10-29

- Lint and TypeScript pass.
- 79 tests pass, including real Postgres RLS tests for two users, transactional
  profile saves, stale-edit conflicts, daily quotas, and real PDF/DOCX import.
- Next.js 16.4.3 production build passes using Webpack, matching the development
  bundler. Turbopack's CSS worker could not open a socket in this environment.
- Production dependency audit reports zero vulnerabilities after compatible
  updates, removal of unused runtime packages, and replacing the XLSX parser.
- Running production server smoke checks confirm 10 private API operations return
  401 without a session, six private pages redirect to sign-in, and cross-origin
  sign-out is rejected. The sign-in screen was inspected in the browser.
- Staging Supabase is provisioned with nine migrations applied and matching
  remote history. Staging is deployed with isolated keys. The user completed real
  email signup; browser checks passed onboarding, resume import and matching
  after fixing step validation. See `staging/README.md` for live evidence and
  remaining acceptance checks. Offline RLS tests use isolated PGlite.
- Billing, paid entitlements, account deletion, CAPTCHA/abuse configuration,
  production ingestion and deployment remain launch gates.

## Resume-first onboarding

Candidates upload or paste a resume, review AI-extracted career history, skills,
education, projects and source passages, then confirm. Search preferences are
optional. Unknown location, tenure and sponsorship remain explicit unknowns;
matching reports those evidence gaps. Existing profiles remain compatible and
no additional database migration is required. Staging QA jobs have been removed.

AI Gateway credits are funded and runtime OIDC is fixed. The cheap Qwen 3.7
Flash model passed live extraction, confirmed profile saving and review rendering
with a separate synthetic account. A direct service call also verified real
source-backed tailoring selection. No QA jobs were reintroduced. Full draft
persistence/export with a genuine job remains an acceptance check; see staging
evidence for the exact tested boundaries.

## Live job supply

Staging now has an isolated, scheduled public catalogue collector with atomic
source snapshots and non-destructive expiry. Actual employer and job-board APIs
populate it; customer page requests only read and rank. Related roles requiring
visa/work confirmation are shown transparently, while strict fit is optional.
No percentage score is used as an applicant assessment. See staging evidence
for source counts, migration history and actual browser checks. Source licenses,
expanded coverage, alerting and production-plan readiness remain launch gates.

Verified a full real-job API flow in staging with separate test accounts:
status persistence → actual provider tailoring → draft edit/save → valid DOCX
export → application list → signout. Cross-account draft edit/download/direct
reads were denied. The live applicant view now has 59 related roles with explicit
sponsorship/work-mode caveats; no fully confirmed strict-fit role is claimed.
92 tests pass; the live sync endpoint and anonymous protections pass.

## Approval-first applications

Supported Ashby job URLs now offer Prepare application. Preparation runs in
Vercel Workflow and reads the employer form using a fresh Browserbase session;
no candidate data is entered into that form during discovery. The existing
cheap model selects resume source passages. Safe experience questions can receive
verbatim source suggestions; immigration, pay, availability, consent and personal
motivation require the candidate's answer.

A private packet stores the destination, discovered fields and notices, answers,
resume, revision and approval snapshot. Saving invalidates approval. Approve &
submit freezes that version; a service-only worker checks the form again, fills
only approved values, records submission intent, clicks once and saves visible
confirmation. Confirmed submissions and the account's Applied status commit in
one transaction. Manual Applied remains a self-reported tracker action.

The worker uses database claims to prevent duplicate sends and concurrent sends
to one employer. Employer limits, changed/conditional forms, unsupported required
controls, default answers not approved by the candidate, CAPTCHA/login and
ambiguous confirmation stop automation. A send that lacks confirmation becomes
submission_unknown and cannot be retried or edited into a new send. The candidate
must check with the employer before applying again. There is no unattended
autopilot or universal ATS claim in this release.

Application tables use owner-only reads with RLS; authenticated roles have no
direct writes. RPCs derive the owner from auth.uid(). Only the runner service
can claim and confirm a send. Five new packets/account/day, three preparation
attempts/packet and the shared ten AI attempts/day bound work. Browser sessions
expire after 800 seconds, never reuse contexts, disable Browserbase automatic CAPTCHA
solving and raw browser logs, and are released in finally. Application session
recording is enabled for debugging; recordings include entered form data and follow
Browserbase retention. The backend delegates supported challenges to 2Captcha. No paid browser plan was chosen.
The free staging allocation is for acceptance testing, not a capacity guarantee
for a public paid launch.

The synthetic employer fixture exists only with APP_ENV=staging and an exact
APPLICATION_TEST_ORIGIN. Operator-created unpredictable tokens identify tests;
no QA job enters the catalogue. The receiver verifies answers and DOCX text
against the approved snapshot, persists one counter/receipt time and sends no
email. `node scripts/verify/verify-application-runner.mjs` creates fictional accounts and
uses only its embedded generated resume; it never reads an existing applicant.
Its private results and credentials are saved under ignored `.local-data/`.


## Site-independent applications (local, 2026-10-30)

Every active public HTTPS listing now exposes Tailor & apply. Eligibility does
not depend on an ATS vendor. The browser discovers application forms in the page
or visible frames, follows clear Apply links and uses a bounded AI SDK tool agent
for ambiguous entry paths. Agent tools only select current observed controls;
credentials, arbitrary code, invented URLs and final submission are outside the
discovery tool interface. Candidate data is entered only after form discovery.
Generic HTML/ARIA form handling supports id-less and name-only inputs, label
selectors, comboboxes and multiple pages. Missing answers stay inside this app.
Existing provider normalizers and the Ashby DOM parser remain optional internal
optimizations, not a coverage promise or a gate.

The ordered additive migrations are `202610300001_automatic_applications.sql` and
`202610300002_site_independent_applications.sql`. They record initial automatic
requests, invalidate stale approvals, atomically continue edited packets, derive
employer identity from catalogue facts rather than ATS URL segments, deduplicate
requests by saved job, and bound additional AI calls through the shared daily
ledger. Chromium Fetch interception checks redirect hops as well as routed
requests; DNS guards reject private/reserved destinations and re-check later
requests. Hosted egress isolation must still be validated before public release.

Local verification: lint, TypeScript, 144 tests and the production build pass.
Postgres tests execute both migrations and check ownership, stale authorization,
provider quotas, packet-version budgets, employer serialization across domains,
idempotence after URL changes, uncertain-send protection and receipt-backed
applied status. The actual AI SDK navigation loop is exercised against a mocked
provider with quota reservation before the call. Chrome passed 11 generic form
extraction checks and ten multi-page fill/pause/continue/confirmation checks
through a DOM adapter using fictional data. A real Browserbase session with the
new network interception retrieved the public example.com page; this validates
connectivity and request interception setup, not employer submission success.

The isolated staging rollout completed on 2026-10-30 with deployment
`dpl_8ohNGAMbTjxUnZQw71HTqg3QQbru` and both migrations applied. Hosted synthetic
continuation and automatic-queue flows passed real AI tailoring, managed browser
form filling, duplicate-request protection, ownership checks and confirmation
receipts. Chrome confirms Tailor & apply on the existing Greenhouse listings.
See `staging/README.md` for commands, run IDs and acceptance boundaries.

Real employer submissions, provider-specific widget variations, login/OTP and
CAPTCHA handoff, and full hosted network-isolation acceptance remain unverified.
The product can attempt applications without knowing the vendor; it cannot
promise successful unattended submission on every website. Production release
still follows the existing launch gates.
