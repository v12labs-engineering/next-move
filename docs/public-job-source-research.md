# Public job source feasibility

Checked 2026-10-29 against primary documentation. Scope: potential sources for
all selectable countries and territories, professions and experience levels.
This is source research, not a measured coverage report or permission to deploy.

## Findings by source

| Source | Access and discovery | Completeness and limits | Reuse evidence |
| --- | --- | --- | --- |
| Greenhouse Job Board API | GET endpoints explicitly require no authentication. Requests need a known `board_token`; the documented list endpoint is per board. No employer-directory endpoint is documented here. | `GET /v1/boards/{board_token}/jobs` describes all job posts; `content=true` includes descriptions. The page documents no pagination parameter or numeric GET rate limit. These are documentation findings, not proof that there are no operational limits. | Documentation describes building company careers pages. A general commercial aggregation license was not established. [Official reference](https://docs.greenhouse.io/job-board) |
| Ashby Job Postings API | The documented GET example uses no credentials and requires an organization's job-board name, taken from its hosted board URL. This is distinct from the authenticated `jobPosting.list` API. No employer-directory endpoint is documented here. | Described as returning all currently published postings for one organization. No pagination or numeric rate limit is documented on this page. `isListed=false` means direct-link-only: exclude these from public listing results. Country metadata can be missing. | Documentation describes an organization's own careers page. A general aggregation license was not established. [Official reference](https://developers.ashbyhq.com/docs/public-job-posting-api) |
| Lever Postings API | Published postings are publicly viewable, and GET examples use no API key. A known company `SITE` is required, on either the global or EU host. The documented interface does not provide an employer directory or global full-text job search. | List requests support `skip` and `limit`; defaults and maximums are not specified in this README. A numeric collection GET rate limit is not stated; the documented two-per-second limit concerns application POSTs and must not be reused as a GET allowance. | Lever explicitly says published jobs may be scraped by third parties. This is useful evidence, but does not establish every downstream redistribution right. Browser CORS is restricted to company domains; use an appropriate server integration. [Official README](https://github.com/lever/postings-api) |
| SmartRecruiters Posting API | Requires a known `companyIdentifier`. Current overview explicitly supports API-key and OAuth authentication, including access to internal postings; do not assume “public” means all access is anonymous. The endpoint guide includes credential-free examples, so production anonymous-access requirements remain to be resolved. No employer-directory endpoint is documented in these pages. | Company listings support `limit` and `offset`, with `totalFound` in results. List fields can be partial; follow the `ref` for full details. A verified adapter must isolate public postings from internal data. | Documentation is framed around customer careers sites. A general aggregation license was not established. [Overview](https://developers.smartrecruiters.com/docs/posting-api), [endpoints](https://developers.smartrecruiters.com/docs/endpoints) |
| Arbeitnow | Its owner describes a free, keyless, multi-source feed with some recent European jobs; the article separately links a UK API. This provides cross-employer supply, unlike a single employer board, but does not establish worldwide coverage. | The official article documents a sponsorship filter. Its linked Postman documentation was not readable in this tool. A single public feed response was inspected for pagination metadata: `links.next`, `meta.current_page`, and instructions to use `page`. No numeric request limit was established. | Response metadata requests considerate use and a link back, and says API use agrees to site terms. A commercial redistribution grant was not established. [Owner's article](https://www.arbeitnow.com/blog/job-board-api), [public response](https://www.arbeitnow.com/api/job-board-api) |

SmartRecruiters separately documents, for most credentialed SmartAPI endpoints,
10 requests/second and eight concurrent requests, response limit headers, and
backoff after throttling. That does not establish an anonymous Posting API
allowance; confirm the adapter's actual access mode and endpoint limits.
[Official rate-limit policy](https://developers.smartrecruiters.com/docs/rate-limiting).

## Implications for the assessment

These are design inferences from the interfaces above:

- Adding an ATS adapter does not discover its employers. Employer-board discovery
  and a maintained board directory are separate work.
- Fetching every posting from a known employer establishes a source snapshot,
  not coverage of a country, profession or seniority level.
- Pagination must follow source metadata or documented termination rules.
  An imposed page/request ceiling means a partial collection, not completeness.
- Prefer structured public listings where access and intended use are clear.
  Record source-specific access, reuse and throttling decisions before expanding
  collection. Missing documentation must remain an explicit unknown.
- Include zero, unmeasured and unavailable segments in the coverage report as
  different states. None of the reviewed sources demonstrates sufficient supply
  for every selectable territory or every profession.

No employer counts, worldwide market share, useful jobs per candidate, uptime,
production request capacity, or successful scheduled collection were measured.
No bulk crawl, authenticated request, private data access or deployment occurred.
One Arbeitnow public response was inspected; it is an observation, not a provider
SLA or a measured inventory. General source terms and employer-specific reuse
rights still require review before adoption beyond the established scope.

## Scheduler feasibility for the six-hour priority-source target

- **Vercel:** Hobby cron jobs are limited to once daily; expressions that run
  more frequently fail deployment. Hobby invocation precision is within the
  scheduled hour. Pro and Enterprise allow a one-minute minimum interval with
  per-minute precision. Cron invokes Functions and consumes the applicable
  function allowances. A read-only lookup of the team linked to the local
  staging project returned its identity but no billing plan. The actual plan
  and remaining allowances remain unverified. A six-hour cron cannot be assumed
  compatible with Hobby.
  [Official cron limits](https://vercel.com/docs/cron-jobs/usage-and-pricing).
- **Possible alternative, not selected: GitHub scheduled Actions.** Schedules
  default to UTC, support an optional IANA timezone and a minimum five-minute
  interval, and run only from the default branch. GitHub explicitly warns that
  schedules can be delayed or dropped under load; public repository schedules
  disable after 60 days without repository activity. A nominal six-hour schedule
  therefore does not guarantee six-hour freshness.
  [Official schedule behavior](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).
- **Free allowance caveat:** Standard hosted runners in public repositories are
  free independently of included compute. Private/internal repository runners
  draw from the owner's shared included compute; overages can be billed.
  Artifact/cache storage has separate limits. Verify account allowance and
  spending controls before treating this as a zero-additional-cost option.
  [Official Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions).

No scheduler was chosen or configured. Existing free allowances are a constraint,
not evidence that either provider can sustain the intended collection volume.
