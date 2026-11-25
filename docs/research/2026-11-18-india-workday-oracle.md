# India employer expansion, 18 November 2026

Research and public feed previews run in local Docker without database credentials. No source was activated or collected into the catalog by these probes. Existing enabled sources were excluded using `.local-data/rollouts/2026-11-18-india-expansion/source-inventory.json`.

## Deloitte India: working public SuccessFactors inventory

The [official Deloitte India board](https://southasiacareers.deloitte.com/go/Deloitte-India/718244/) exposes server-rendered HTML, 25 positions per numbered page, newest posting dates first. At 06:40 UTC it reported 2,160 positions. A later complete 87-page listing pass returned 2,161 positions representing 2,160 distinct posting URLs: one requisition appears at the boundary between offsets 800 and 825. These are listing counts, not eligible catalog additions.

The [public robots policy](https://southasiacareers.deloitte.com/robots.txt) permits the `/go/` listing and `/job/` description paths and disallows `/services/`, application and talent-community paths. The reader only requests the permitted listing and job pages. It does not request application endpoints.

The [observed SRE job](https://southasiacareers.deloitte.com/job/Bengaluru-Senior-Consultant-SRE-Devops-Engineering-Bengaluru/59120444/) provides full job description HTML, a canonical job URL, posting-date microdata, employer microdata and explicit `Bengaluru, IN` location metadata. Source identity is fixed as `successfactors:deloitte-india`, company `Deloitte`, board `deloitte-india`, configuration `{}`. The selected catalog scope requires an explicit India country, a complete description, a supported category, and an exact employer posting date within the snapshot's preceding 30 days.

The website's cookie explanation explicitly identifies its public session cookies as necessary for session and load-balancer stickiness. Without preserving `JSESSIONID`, adjacent requests alternated between totals 2,160 and 2,161. Six subsequent requests preserving the site's own cookie returned consistent totals. The reader retains only this provider-issued cookie during a page read; it is neither a login session nor persisted to the catalog. A partial overlap between two correctly numbered index pages is accepted only when canonical URL, title, location and posting date agree; conflicting duplicates and wholly repeated pages fail. Catalog publication and measurement deduplicate posting identities.

The final strict preview completed at **07:07:54 UTC**: **538 unique eligible India postings**, across **87 pages**, **2,163 listing positions** and **914 requests**. The live board gained positions during the scan; the earlier complete listing-only observation above is a separate receipt. Canonical URL and numeric provider-posting-ID counts both equal 538. An independent audit verified explicit India country, full descriptions of at least 100 characters, and actual employer `postedAt` values within the exact 30-day snapshot window for all 538.

Category totals: 498 software, 20 data, 7 product, 6 sales, 5 marketing and 2 design. All eight supported categories were requested; customer success and technical support contributed zero accepted jobs in this run. These are potential source jobs, not additional catalog jobs. Only the rollout's before/after catalog comparison determines actual new unique additions.

The activation-ready manifest is `.local-data/rollouts/2026-11-18-india-expansion/workday-oracle/activation-ready.json`. It keeps `enabled=false`; activation belongs to the separate local rollout. A full preview took about nine minutes, so the manifest recommends `collection_interval_seconds=2700` (45 minutes after last success) to leave room for the scan before the next hourly completion. An initial explicit collection establishes published India evidence; directory country hints alone do not qualify a new source for the India scheduler.

Evidence under `.local-data/rollouts/2026-11-18-india-expansion/workday-oracle/`:

- `deloitte-initial.jsonl`, `deloitte-listing.html`, `deloitte-job.html`: official listing, robots and full-detail contract.
- `deloitte-boundary.jsonl`, `deloitte-sticky.jsonl`: pagination/session diagnosis.
- `deloitte-inventory.jsonl`: all 87 listing pages and their position ranges.
- `deloitte-reader*.jsonl`: strict preview runs; failed attempts explicitly retain a `failed` result.
- `deloitte-consultants.jsonl`: four full official descriptions used to evaluate title-policy gaps.

### Category coverage gap

The [`.NET consultant` posting](https://southasiacareers.deloitte.com/job/Bengaluru-Consultant-_NET-Bengaluru-SAP-DSA-SAP-Accounts/61599344/) explicitly develops .NET/C# Azure applications, REST APIs and microservices, but the existing title prefilter excludes it because its title omits engineer/developer. The [Microsoft Power Platforms consultant](https://southasiacareers.deloitte.com/job/Bengaluru-Senior-Consultant-Microsoft-Power-Platforms-Bengaluru-Emerging-ERP-Solutions/61601344/) similarly describes application development, automation and integrations. The implemented narrow aliases require explicit application-development evidence for .NET or Power Platform consultant titles; neither title alone nor generic employer software boilerplate qualifies. The examined Oracle PLM Tech and SAP Analytics Cloud consultant postings describe functional configuration or financial planning; their technology words alone do not establish software engineering.

## Workday holds

Rechecked at 06:37 UTC from local Docker:

| Officially observed employer board | Result |
| --- | --- |
| `adobe.wd5.myworkdayjobs.com~external_experienced` | robots HTTP 429; held |
| `citi.wd5.myworkdayjobs.com~2` | robots HTTP 429; held |
| `mastercard.wd1.myworkdayjobs.com~CorporateCareers` | robots HTTP 429; held |
| `nvidia.wd5.myworkdayjobs.com~NVIDIAExternalCareerSite` | robots HTTP 429; held |

None provided a `Retry-After` header. The probe stopped after each throttle; no alternative origin or access workaround was used. Existing Salesforce, ServiceNow and the previously verified large Workday sources are already enabled in the inventory. Board ownership evidence for these four employers remains in [yesterday's research](2026-11-17-india-expansion-workday-oracle.md); today's throttle receipts are in `initial-workday.jsonl`.

The [official Wolters Kluwer careers page](https://careers.wolterskluwer.com/en) links to `wk.wd3.myworkdayjobs.com/External`; no full feed preview was performed after prioritizing Deloitte. The [official Thomson Reuters careers URL](https://careers.thomsonreuters.com/us/en) redirects to `thomsonreuters.wd5.myworkdayjobs.com/en-US/External_Career_Site`, which returned HTTP 429; held.

## Additional Oracle leads, not activation-ready

The [official Tata Capital careers page](https://www.tatacapital.com/careers.html) links to `eofh.fa.em2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX`. The [official Kotak careers page](https://www.kotak.bank.in/en/about-us/careers.html) links to `hcbt.fa.em2.oraclecloud.com`, sites `CX` and `CX_4001`. These are observed identities; full India and category inventories remain unverified. They have not been added to the Oracle tenant allowlist.

[Goldman Sachs' India careers page](https://www.goldmansachs.com/worldwide/india/careers/) currently links to `higher.gs.com`, not directly to the Oracle tenant referenced by secondary sources. [Ford's official careers page](https://www.careers.ford.com/en) links to `apply.ford.com`, but this origin still failed the direct probe. No guessed Oracle identity was activated.

## Implementation verification

- `lib/server/catalog/connectors/successfactors.ts`: reviewed fixed Deloitte source, full HTML details, bounded listing pages, robots checks, public session stickiness, exact country/date/identity checks, and consistent duplicate index handling.
- `supabase/migrations/202611180087_successfactors_deloitte.sql`: permits the fixed source and scoped-search kind without enabling any source. The fixture applies actual Qualcomm migration 086 first, then verifies its scope remains unchanged and both source kinds remain searchable.
- `lib/jobs/software-roles.ts`: only the evidenced .NET and Power Platform consultant aliases were added; functional, finance/planning and generic software boilerplate remain excluded.
- 28 targeted tests passed across Deloitte, category policy, software roles and IBM. The updated 086→087 migration fixture also passed all seven Deloitte tests. Final TypeScript and ESLint checks passed. No live database, source activation or Vercel mutation was performed by this research task.
