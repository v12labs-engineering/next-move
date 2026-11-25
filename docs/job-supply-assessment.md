# Job supply assessment

Status: implementation approved on 2026-10-29. The baseline below describes the
pre-change code. Implementation and measured verification are recorded in
`catalog-operations.md` and `staging/README.md`; numerical supply targets and
worldwide coverage are not implied by a successful collector run.

## Agreed direction

- Serve both domestic and international job seekers.
- Measure coverage before setting minimum job-supply targets.
- Start with public feeds; consider paid data after measuring coverage gaps.
- Assess India and every currently selectable destination: 249 countries and
  territories in the current directory. Country selection is not evidence of
  supply; unsupported and empty destinations belong in the assessment.
- Source software engineering roles at every experience level, from CTO and
  engineering leadership to junior developers and software interns. This scope
  supersedes the original all-professions direction (2026-11-02).
- Apply the shared software-role policy before catalogue publication, then show
  each candidate recommendations relevant to their confirmed roles, resume,
  experience and search preferences. Employer industry alone cannot qualify a job.
- Show unknown sponsorship with an explicit caveat and count confirmed
  role-level sponsorship separately.
- Keep destinations selectable while clearly showing limited or unavailable
  coverage and the last successful update.
- Include listings in all languages, retaining source text. Assess matching
  quality by language rather than assuming English rules generalize.
- Use existing free infrastructure allowances for the first measurement. No
  purchase or paid plan is authorized by this design discussion.
- Prioritize sources serving aggregate candidate demand, with rotating baseline
  checks for the remaining source directory. Do not send candidate identities or
  resume contents to job sources.
- Aim to detect new or removed postings on priority sources within six hours and
  measure feasibility. This is a target, not a verified service guarantee.

## Current code baseline

- `vercel.json` schedules `/api/catalog/sync` daily. Actual automatic execution
  has not been verified in this assessment.
- `lib/server/catalog/feeds.ts` configures five Ashby employer boards, two
  Greenhouse employer boards and Arbeitnow. The scheduled path does not discover
  additional employers. Arbeitnow fetches only pages 1–3.
- `lib/server/catalog/sync.ts` processes sources in batches of two inside a
  request with a 300-second maximum. Source fetches have a 20-second timeout.
  This path has no durable continuation or automatic retry/backoff.
- `supabase/migrations/202610290002_live_catalog.sql` provides per-source leases
  and atomic snapshot publication, preserving previous data on failed fetches.
  It rejects snapshots larger than 5,000 records. Complete snapshots deactivate
  missing jobs; incomplete snapshots expire unseen jobs after seven days.
- `lib/server/account-store.ts` selects at most 3,000 active, recently checked
  listings in selected countries before matching, ordered by discovery date.
  Increasing catalogue size can crowd relevant older listings out of that pool.
- The legacy sponsor collection path supports more feeds and register crawling,
  but is not on the daily schedule. It assigns metadata and scores from a
  personal senior engineering profile, but currently does not check that
  profile's `keep` result before publishing. Comments claiming profile filtering
  are stale and do not establish exclusion of other professions.
- The public matching schema accepts arbitrary target-role text, but related-role
  expansion and skill-based profession recognition favor engineering titles.
  Seniority and experience parsing rely on English patterns. Cross-profession
  and cross-language matching quality require assessment alongside job supply.
- The legacy publisher in `lib/server/app-state-store.ts` does not set catalogue
  freshness or reactivate inactive rows. Reusing it requires addressing the
  account reader's freshness contract.
- Customer Refresh reloads and ranks saved catalogue data; it does not collect.
- Daily catalogue sync stores latest source status, not an append-only run
  history. Current records permit a snapshot assessment but cannot reliably
  reconstruct historical fetched, rejected, duplicate, new or expired counts.

## Measurement proposal

For agreed candidate segments, measure the path from fetched records to valid
listings, distinct vacancies, recently checked vacancies and relevant results.
Assess useful supply after candidate-specific matching, including candidates
from different professions with the same destination. A high catalogue count
does not compensate for an individual candidate receiving no relevant jobs.
Separate country, city, role and experience-level coverage. Count confirmed
role-level sponsorship separately from unknown sponsorship. Track newly
discovered vacancies separately from refreshed existing ones; location variants
and repeated fetches must not inflate volume.

Record run duration, source failures, last successful check and observed request
volume alongside coverage. A successful parser test or configured schedule does
not establish live supply, source completeness or successful automatic execution.

Report observed supply, not a percentage of the entire job market: the market's
total inventory is not known. Distinguish destinations with no configured source,
sources not yet measured, failed or stale sources, successful partial snapshots,
and successful complete snapshots returning zero results. Preserve unknown role,
experience and language classifications explicitly.

Official-source research is recorded in `public-job-source-research.md`.
Employer-scoped ATS interfaces require known employer identifiers; an adapter
does not provide employer discovery. The reviewed documentation does not
establish worldwide supply or general commercial redistribution rights.

## Proposed implementation sequence for review

1. Create a repeatable assessment of current catalogue supply across the entire
destination directory, with explicit gaps and breakdowns for professions,
experience, languages and sponsorship where evidence permits. Include matching
checks for software roles, excluded professions and languages so retrieval failures are visible
separately from collection failures. Report unclassified records explicitly.
Verify that each candidate sees their own relevant recommendations and that
jobs from unrelated professions are excluded even when skills or locations overlap.

2. Add persistent per-run measurements for future fetched, rejected, duplicate,
new, updated and expired counts, request volume, duration and failure recovery.
The first snapshot is immediately assessable once the data path is verified;
trends need new observations and must not be reconstructed from overwritten
source state. City checks and representative candidate examples are diagnostic
samples, not proof that every city or profession is covered.

3. Use measured gaps to prioritize employer-board discovery and source expansion.
Keep a maintained directory of verified source identifiers and scope. Fetch
complete snapshots where supported and persist continuation for bounded partial
runs. Report source restrictions and unknown reuse/access conditions explicitly.

4. Plan collection independently of customer page requests, with bounded workers,
retry/backoff, durable continuation and demand-based priority plus rotating
baseline checks. Verify whether existing free scheduling and worker capacity can
support the six-hour target. Propose any required paid alternative separately.

5. Remove retrieval truncation that can hide relevant jobs as the catalogue grows,
and address language/profession-specific matching gaps demonstrated by benchmarks.
Present measured coverage and source freshness, including limited, unavailable
and unknown supply, alongside candidate search results.

Set quantitative supply targets after the baseline, consistent with the user's
decision. Keep original listing text and provenance; a translated or normalized
field cannot substitute for source evidence of location, experience or sponsorship.

Changes requiring a migration must be additive, tested locally against an
isolated database, and verified in staging before any production rollout. No
production migration, deployment or paid service change is included merely by
accepting this design.

## Scheduler feasibility and remaining review

Official Vercel limits exclude a six-hour cron on Hobby. The linked staging
team's read-only lookup did not expose its billing plan, so current capacity
remains unverified. GitHub scheduled Actions supports the cadence, subject to
repository/account allowances and delayed or dropped runs; it is a possible
alternative to evaluate, not a selected scheduler. See the primary-source
research for evidence. Keep the six-hour target subject to measured feasibility.

The user confirmed implementation and clarified that broad catalogue collection
must produce only candidate-relevant recommendations in each account. The
six-hour target remains subject to measured source and infrastructure capacity.

## Verification before implementation

Use repeatable coverage measurements before selecting a volume target. Any
collector change needs evidence for pagination/completeness, deduplication,
freshness and expiry, failure recovery, and retrieval of relevant jobs as the
catalogue grows. Validate live source access and permitted use before adopting
additional feeds. Existing fixture tests alone cannot establish those outcomes.
