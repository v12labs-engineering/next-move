# Verified India expansion: Workday and Oracle

Verified on 2026-11-17 from local Docker. No source activation or database writes were performed by these probes. The existing directory had only Oracle, BNY and IBS Software Oracle tenants; none of the employers below had an Oracle source. Workday candidates were compared against all 39 existing Workday directory rows.

## Ready feeds

These are complete, strictly validated connector snapshots, not search-result estimates. Counts include supported software-adjacent categories, exclude early-career postings and require full descriptions, an explicit India country, an open posting and an employer posting date within 30 days. They are potential collection volume, not additional unique catalog jobs; only the subsequent before/after catalog comparison can establish that.

| Employer | Source configuration | Live accepted unique India postings | Complete snapshot evidence |
| --- | --- | ---: | --- |
| JPMorgan Chase | `id=oracle:jpmorgan-chase`, `kind=oracle`, `board=jpmorgan-chase`, `company=JPMorgan Chase`, `config={}` | 97 | 224 summaries, 23 pages, 145 requests; completed 12:53:49 UTC |
| Nokia | `id=oracle:nokia`, `kind=oracle`, `board=nokia`, `company=Nokia`, `config={}` | 28 | 99 summaries, 10 pages, 64 requests; completed 12:53:10 UTC |
| Emerson | `id=oracle:emerson`, `kind=oracle`, `board=emerson`, `company=Emerson`, `config={}` | 32 | 102 summaries, 11 pages, 87 requests; completed 12:57:51 UTC |

JPMorgan's [official recruiting site](https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001/jobs?location=India&locationId=300000000289360&locationLevel=country&mode=location) uses tenant `jpmc.fa.oraclecloud.com`, site `CX_1001`. Its live API reported 288 India openings, including 224 in its less-than-30-days facet. The strict catalog projection returned 84 software, 5 data, 4 product, 3 marketing and 1 technical-support posting. Evidence: [raw feed metadata](../../.local-data/rollouts/2026-11-17-india-expansion-2/workday-oracle/third-feeds.jsonl) and [complete reader observations](../../.local-data/rollouts/2026-11-17-india-expansion-2/workday-oracle/reader-results.jsonl).

[Nokia's official careers page](https://www.nokia.com/careers/) links to [jobs.nokia.com](https://jobs.nokia.com/en/sites/CX_1). That page explicitly embeds the backend origin `fa-evmr-saasfaprod1.fa.ocs.oraclecloud.com`, site `CX_1`; it was not guessed. Its API reported 148 India openings, 99 in the less-than-30-days facet. The strict catalog projection returned 20 software, 4 technical-support, 2 sales and 2 product postings. Public application links retain Nokia's `https://jobs.nokia.com/en/sites/CX_1/job/{id}` domain. Evidence: [observed official links](../../.local-data/rollouts/2026-11-17-india-expansion-2/workday-oracle/official-links-second.jsonl) and the complete reader observations above.

[Emerson's official careers page](https://www.emerson.com/en/corporate/careers/career-opportunities) links directly to `hdjq.fa.us2.oraclecloud.com`, site `CX_1`. Its live India feed returned 220 total summaries and 102 in the less-than-30-days facet. A complete strict projection produced 32 unique eligible postings. Evidence: [official link extraction](../../.local-data/rollouts/2026-11-17-india-expansion-2/workday-oracle/official-links-third.jsonl), [feed metadata](../../.local-data/rollouts/2026-11-17-india-expansion-2/workday-oracle/emerson-feed.jsonl) and [complete reader observations](../../.local-data/rollouts/2026-11-17-india-expansion-2/workday-oracle/emerson-reader-results.jsonl). The three complete sources offer 157 unique application URLs combined before comparison with the existing catalog.

## Verified feeds held from activation

[Honeywell's official careers page](https://www.honeywell.com/us/en/careers) links to `ibqbjb.fa.ocs.oraclecloud.com`, site `Honeywell`. The [official feed](https://ibqbjb.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/Honeywell/jobs) returned 307 India summaries, 237 in its less-than-30-days facet. Full collection failed on page 3 because requisition `161549`, “Sr Channel Sales Rep”, has empty full description, responsibilities and qualifications. Its short summary also mentions Charlotte despite an India country field. The strict reader refuses publication rather than substituting the short summary or publishing an incomplete source. Keep this source disabled. [Exact failing public detail response](../../.local-data/rollouts/2026-11-17-india-expansion-2/workday-oracle/honeywell-detail.json).

## Workday findings

| Employer | Board observed on official employer site | Live result from local Docker |
| --- | --- | --- |
| Adobe | `adobe.wd5.myworkdayjobs.com~external_experienced`, observed in [official search-result application links](https://careers.adobe.com/us/en/search-results) | CXS API 200, 252 global postings; nested `locationCountry` India facet has 37. Freshness and full India details remain unverified. `robots.txt` returned 429; hold discovery verification. |
| Mastercard | `mastercard.wd1.myworkdayjobs.com~CorporateCareers`, linked by [official careers page](https://careers.mastercard.com/us/en) | CXS and robots returned 429; no activation. |
| Citi | `citi.wd5.myworkdayjobs.com~2`, linked by [official careers page](https://jobs.citi.com/) | CXS and robots returned 429; no activation. |
| NVIDIA | `nvidia.wd5.myworkdayjobs.com~NVIDIAExternalCareerSite`, confirmed by [NVIDIA's own support forum](https://forums.developer.nvidia.com/t/need-help-with-workday-login-for-applications/354521) | Board, CXS and robots returned 429; no activation. |

Adobe's observed India country facet ID is `c4f78be1a8f14da0ab49ce1162348a5e`. The current Workday collector does not accept country-facet configuration and rejects global inventories of 2,000 or more rather than silently trusting a capped slice. Adobe's measured global total is below that limit; no claim is made that the other blocked boards are below it. [First feed probes](../../.local-data/rollouts/2026-11-17-india-expansion-2/workday-oracle/first-feeds.jsonl), [Adobe feed metadata](../../.local-data/rollouts/2026-11-17-india-expansion-2/workday-oracle/third-feeds.jsonl).

Ford's official careers site links to `apply.ford.com`, but that application origin could not be fetched successfully in the local probe. An Oracle tenant mentioned by secondary sites was not promoted into the allowlist without first-party corroboration. Deutsche Bank's current official search page did not expose a verified Workday board in the bounded read. Neither was activated.

## Reader and rollout requirements

The Oracle extension pins `location=India` and a 31-day server search window to the snapshot start on every page; the full-detail date check enforces the exact 30-day lower and upper bounds. The one-day API grace handles day-precision summary dates. Pagination verifies tenant/site, country, offset, page length and total; source completion is never inferred from a capped sample.

The Oracle robots behavior now matches the existing discovery policy: a 4xx robots resource is unavailable under RFC 9309, except 429, which remains a throttle. Actual job API 401/403 responses still fail. JPMC's robots endpoint returned 403 while its public job API returned 200; Nokia and Honeywell robots endpoints returned 404. No access-control workaround or alternative network origin was used.

Migration `202611170084_verified_oracle_employers.sql` widens only the reviewed tenant constraint and creates or enables no source. The normal collector CLI accepts the reviewed source IDs. Tests cover complete pagination, pinned date windows, full details, provider identity, actual API authorization failures, robots throttling/disallow rules and the no-activation migration property.

Verification: `node --import tsx --test tests/oracle-india-catalog.test.ts tests/oracle-verified-employers.test.ts tests/additional-ats.test.ts` passed all 27 tests; ESLint passed for the modified reader, source identity helper and Oracle tests. The Honeywell tenant remains a verified employer identity but is deliberately excluded from the activation-ready manifest.

Oracle tenants are not ordinary ATS discovery candidates under the current `source_candidates.kind` constraint. The rollout operator must enable reviewed directory rows and perform the first successful collection; their published India rows then establish hourly India scheduling eligibility. Do not assume directory country hints alone qualify a never-collected source for the India scheduler.

## Reproducibility

Public request probes, raw responses and complete accepted-posting observations are under `.local-data/rollouts/2026-11-17-india-expansion-2/workday-oracle/`. `reader-probe.mts` runs repository readers in a separate local Docker container with the repository mounted read-only and without database credentials. Script target lists were advanced between probe batches; saved response files identify the exact targets and timestamps for each batch.
