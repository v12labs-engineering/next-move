# Open-source employer discovery: implementation research

Checked 2026-10-30. This is static source research, not a running integration or measured live coverage. No upstream code was executed, dependencies installed, data-provider account created, or bulk crawl performed.

## Findings

A working open-source analogue exists: **Freehire's own ingestion/discovery engine**, which is a different project from the personal agent workflow originally linked. Its canonical repository was reached through the GitHub link in [Freehire's official terms](https://freehire.me/terms): [strelov1/freehire](https://github.com/strelov1/freehire). The relevant design is **multiple candidate sources → canonical ATS identity → live validation → persistent board directory → separate job collection**. Search alone is only one candidate source.

| Project and inspected revision | What it contributes | Boundary |
| --- | --- | --- |
| Freehire — [`8f41c56537434d843d48e69f25ceb12a04fc91cc`](https://github.com/strelov1/freehire/commit/8f41c56537434d843d48e69f25ceb12a04fc91cc) | Actual Common Crawl, employer-domain, public-list and inventory discovery tools; adapter registry, probers, Postgres board lifecycle and ingest scheduler. | Go implementation, active development, substantial application-specific dependencies. Selected code/patterns can be ported; copying the app is unnecessary. |
| Outscal OpenJobs — [`cdcc533521afb61f4e60657b3dbe06e484ccddcf`](https://github.com/outscal/OpenJobs/commit/cdcc533521afb61f4e60657b3dbe06e484ccddcf) | A company/ATS-link seed dataset and Node adapters/probers. | Primarily gaming/tech; April 2026 snapshot; liveness and counts require verification. |
| Elliott Dehn Open Jobs — [`6f47bc050c9536c59ac771ca14aa507a25253348`](https://github.com/elliottdehn/open-jobs/commit/6f47bc050c9536c59ac771ca14aa507a25253348) | Historical ATS board identifiers, static-HTML/JobPosting discovery design and ATS adapter examples. | README says crawler/search/build were shut down 2026-10-10; last snapshot 2026-10-05. It is a candidate/code source, not a fresh feed. |

## 1. Freehire: a concrete model for the missing subsystem

### A. Mine web-crawl indexes for ATS tenants

[`cmd/harvest-boards/commoncrawl.go`](https://github.com/strelov1/freehire/blob/8f41c56537434d843d48e69f25ceb12a04fc91cc/cmd/harvest-boards/commoncrawl.go) fetches Common Crawl's collection list and sweeps the latest **three** snapshots. It asks CDX for page counts, then reads JSONL pages and extracts board identifiers from URL shapes. The Go implementation supports host-pattern-specific extraction rather than pretending every ATS uses the same path layout.

[`prober.go`](https://github.com/strelov1/freehire/blob/8f41c56537434d843d48e69f25ceb12a04fc91cc/cmd/harvest-boards/prober.go) wires Greenhouse and Ashby discovery to hosted-board URL prefixes. [`workday_discover.go`](https://github.com/strelov1/freehire/blob/8f41c56537434d843d48e69f25ceb12a04fc91cc/cmd/harvest-boards/workday_discover.go) handles tenant subdomains and derives `<host>/<site>`, rejecting locale, static-asset and non-site paths. That is materially more precise than guessing a company slug or collecting individual job URLs.

**Adaptation:** Store crawl timestamp and original candidate URL as discovery provenance. Historical URL presence only proposes a board; independently fetch the current source before enabling collection. Upstream caps reads at **40 pages per snapshot** and accepts some truncated JSONL bodies: those are discovery limits, not an exhaustive-inventory guarantee. Our output should explicitly record capped/partial discovery.

### B. Follow known employer domains to their careers pages

[`cmd/harvest-ats/main.go`](https://github.com/strelov1/freehire/blob/8f41c56537434d843d48e69f25ceb12a04fc91cc/cmd/harvest-ats/main.go) accepts company worklists from curated datasets and a university-domain directory. [`resolve.go`](https://github.com/strelov1/freehire/blob/8f41c56537434d843d48e69f25ceb12a04fc91cc/cmd/harvest-ats/resolve.go) fetches the homepage, follows a careers link, tries seven conventional careers paths and careers/jobs/hr subdomains, and follows one deeper vacancy link. It detects both ATS URLs and vendor fingerprints on employer-owned domains. It uses static fetches; JavaScript-only sites remain unresolved.

[`internal/ingest/atsdetect/atsdetect.go`](https://github.com/strelov1/freehire/blob/8f41c56537434d843d48e69f25ceb12a04fc91cc/internal/ingest/atsdetect/atsdetect.go) is a pure classifier over markup; [`fromurl.go`](https://github.com/strelov1/freehire/blob/8f41c56537434d843d48e69f25ceb12a04fc91cc/internal/ingest/atsdetect/fromurl.go) delegates canonical URL-to-board recognition to a shared ATS registry. Host-boundary checks avoid classifying lookalike domains. Self-hosted ATS detection only runs after explicit ATS links have been considered.

**Adaptation:** Use a bounded domain-following worker with a real HTML parser, multilingual careers-link vocabulary, URL/network controls, redirect/DNS validation and source-specific crawl policy. Preserve multiple legitimate regional boards rather than returning only the first board. Known-domain worklists can widen profession coverage; employer headquarters must not become inferred job location.

### C. Harvest existing lists and outbound links

[`scripts/harvest_boards.py`](https://github.com/strelov1/freehire/blob/8f41c56537434d843d48e69f25ceb12a04fc91cc/scripts/harvest_boards.py) reads public GitHub JSON job lists, optionally searches GitHub code, and mines Hacker News Who Is Hiring comments for ATS links. [`scripts/ats_boards.py`](https://github.com/strelov1/freehire/blob/8f41c56537434d843d48e69f25ceb12a04fc91cc/scripts/ats_boards.py) shares extraction, live checks, catalogue deduplication and seed emission. [`cmd/seed-from-inventory`](https://github.com/strelov1/freehire/blob/8f41c56537434d843d48e69f25ceb12a04fc91cc/cmd/seed-from-inventory/main.go) converts external company/ATS CSVs into per-provider candidate files; [`convert.go`](https://github.com/strelov1/freehire/blob/8f41c56537434d843d48e69f25ceb12a04fc91cc/cmd/seed-from-inventory/convert.go) uses the same canonical recognizer and counts unrecognized URLs.

**Adaptation:** Treat these as provenance-bearing candidate inputs. Review each list's licence and relevance; never equate number of rows with live employers or copy author claims such as sponsorship. Existing lists strongly favor technology/new-grad roles, so independent regional/sector seed sources are needed.

### D. Search is supplementary discovery, with limitations

[`scripts/discover_boards.py`](https://github.com/strelov1/freehire/blob/8f41c56537434d843d48e69f25ceb12a04fc91cc/scripts/discover_boards.py) implements DuckDuckGo HTML, Google Custom Search, a commercial SERP service, GitHub code search and Common Crawl channels. It extracts ATS URLs and filters them back to the requested provider.

This is implemented code, **not evidence those services are currently available or permitted for our use**. Current credentials, API availability, quotas and terms need separate verification. Its Python Common Crawl channel is less capable than its Go counterpart: it ignores the keyword and only queries a host/path prefix, so subdomain-based tenants are missed. Its raw-DDG scraper should not become our default dependency merely because it exists.

### E. Validate candidates before activating collection

[`cmd/harvest-boards/main.go`](https://github.com/strelov1/freehire/blob/8f41c56537434d843d48e69f25ceb12a04fc91cc/cmd/harvest-boards/main.go) deduplicates against the current directory, probes candidates with bounded concurrency, and can corroborate the employer name or a known posting ID. It refuses to commit a run dominated by throttling, a run in which all probes failed, or systemic identity mismatches. It reports by default and writes only with `--apply`.

Survivors enter **pending** in Postgres; a successful actual pipeline crawl promotes them to **active**. [`catalog.go`](https://github.com/strelov1/freehire/blob/8f41c56537434d843d48e69f25ceb12a04fc91cc/internal/ingest/boardcatalog/catalog.go) defines pending/active/rejected/retired states; [`repository.go`](https://github.com/strelov1/freehire/blob/8f41c56537434d843d48e69f25ceb12a04fc91cc/internal/ingest/boardcatalog/repository.go) validates through the adapter registry, deduplicates canonical identities and retains retired/rejected records. A valid employer board with zero current jobs should be retained separately as an empty but recognizable source; upstream nonempty-probe filtering is too narrow for that discovery goal.

**What not to copy:** company-name slug guesses as proof of ownership; high concurrency defaults without our own provider measurements; treating a timeout as a definitive dead employer; provider-specific proxy/refusal workarounds; silently enabling a candidate before access/scope review.

### F. Discovery and freshness remain separate jobs

[`cmd/ingest/crawl_order.go`](https://github.com/strelov1/freehire/blob/8f41c56537434d843d48e69f25ceb12a04fc91cc/cmd/ingest/crawl_order.go) rotates never-crawled and oldest-checked boards first so deadlines do not permanently starve newly added boards. [`internal/ingest/ingestsched/AGENTS.md`](https://github.com/strelov1/freehire/blob/8f41c56537434d843d48e69f25ceb12a04fc91cc/internal/ingest/ingestsched/AGENTS.md) documents durable provider schedules and runtime state; deployed timer/worker host provisioning is an operational dependency.

The current repository no longer ships its board inventory as YAML: collection reads the Postgres `boards` table. The [loader](https://github.com/strelov1/freehire/blob/8f41c56537434d843d48e69f25ceb12a04fc91cc/internal/ingest/boardcatalog/loader.go) and [schema migration](https://github.com/strelov1/freehire/blob/8f41c56537434d843d48e69f25ceb12a04fc91cc/migrations/0123_boards.sql) confirm this. **Cloning Freehire does not provide its hosted employer catalogue.**

The [catalogue filter](https://github.com/strelov1/freehire/blob/8f41c56537434d843d48e69f25ceb12a04fc91cc/internal/ingest/pipeline/catalogue_fit.go) rejects confirmed non-technical titles according to its own classification rules. We must not import that policy into this project's all-profession catalogue. Keka and greytHR [probe implementations](https://github.com/strelov1/freehire/blob/8f41c56537434d843d48e69f25ceb12a04fc91cc/cmd/harvest-boards/keka_prober.go), [greytHR](https://github.com/strelov1/freehire/blob/8f41c56537434d843d48e69f25ceb12a04fc91cc/cmd/harvest-boards/greythr_prober.go) show regional ATS expansion is feasible, but their existence does not establish India coverage.

**Licence:** The inspected [MIT licence](https://github.com/strelov1/freehire/blob/8f41c56537434d843d48e69f25ceb12a04fc91cc/LICENSE) permits code reuse with required notices. Hosted Freehire data has separate [service/data terms](https://freehire.me/terms); the code licence is not a blanket grant for third-party postings.

## 2. Outscal OpenJobs: a useful candidate worklist, not a live directory

The [README](https://github.com/outscal/OpenJobs/blob/cdcc533521afb61f4e60657b3dbe06e484ccddcf/README.md) describes `data/companies_v2.json` as 12,144 gaming/tech company records, 7,007 with ATS links and about 2,100 routable to included adapters. Those numbers are **upstream descriptions**, not independently counted or live-tested here. The repository tree confirms the dataset file exists at roughly 4.2 MB; the GitHub Contents response did not return its body, so a full record audit was not performed.

The [probe implementation](https://github.com/outscal/OpenJobs/blob/cdcc533521afb61f4e60657b3dbe06e484ccddcf/probe-ats.mjs) derives up to three name/slug variants, probes public ATS shapes, writes candidate CSVs and reports rate limits. It recognizes the false-positive trap where arbitrary SmartRecruiters slugs return an empty success response. Its assumption that different tenant hosts allow higher safe concurrency is not a provider allowance; do not reuse that conclusion without measurement.

The repository's [MIT licence](https://github.com/outscal/OpenJobs/blob/cdcc533521afb61f4e60657b3dbe06e484ccddcf/LICENSE) attributes both original career-ops authorship and Outscal additions. Its [disclaimer](https://github.com/outscal/OpenJobs/blob/cdcc533521afb61f4e60657b3dbe06e484ccddcf/LEGAL_DISCLAIMER.md) leaves third-party access conditions to the user. Use employer name/site/ATS URLs as **seed candidates**, verify ownership and live source responses, and preserve the original attribution. A source's country-history field must not become a current role location or sponsorship claim. The README's multi-country-to-relocation suggestion is unsuitable for this project's evidence rules.

## 3. Elliott Dehn Open Jobs: historical seeds and a broader-domain design

The [README](https://github.com/elliottdehn/open-jobs/blob/6f47bc050c9536c59ac771ca14aa507a25253348/README.md) explicitly reports the service shutdown and last snapshot dates. [`slugs.json`](https://github.com/elliottdehn/open-jobs/blob/6f47bc050c9536c59ac771ca14aa507a25253348/slugs.json) and [`build-boards.mjs`](https://github.com/elliottdehn/open-jobs/blob/6f47bc050c9536c59ac771ca14aa507a25253348/backend/scripts/build-boards.mjs) provide a route from historical ATS identifiers to a candidate board list, including separate live-at-snapshot and gone categories. Neither is a statement of present availability. Large snapshot downloads are unnecessary for initial discovery; no 31 GB archive was downloaded.

[`backend/CRAWLER.md`](https://github.com/elliottdehn/open-jobs/blob/6f47bc050c9536c59ac771ca14aa507a25253348/backend/CRAWLER.md) documents Web Data Commons JobPosting-domain seeding, removal of already-covered ATS/aggregator domains, static sitemap/HTML extraction and escalation experiments. Its reported yields/costs are project-specific historical measurements or estimates; they are not our benchmarks or current infrastructure pricing. The useful principle is to **validate static extraction on a sample before building a browser fleet**, then independently enumerate current job URLs rather than trust old archive postings.

[`discover-careers.py`](https://github.com/elliottdehn/open-jobs/blob/6f47bc050c9536c59ac771ca14aa507a25253348/backend/scripts/discover-careers.py) uses paid model web search to propose official career sites, caches candidates, then mechanically fingerprints ATS endpoints/redirects. It is evidence of a possible optional fallback. It is not suitable to copy directly: it disables TLS certificate verification, includes legacy credential-file handling, and uses aggressive fixed concurrency. Keep standard TLS verification, explicit secret configuration and verified network boundaries.

The repository [licence](https://github.com/elliottdehn/open-jobs/blob/6f47bc050c9536c59ac771ca14aa507a25253348/LICENSE) is **CC0**, not MIT. That is the repository's copyright dedication; source-employer rights remain separate.

## 4. Open ATS Feed: the smallest directly reusable discovery reference

Added after inspecting [`veresk06/open-ats-feed` at `01b3908c8a8fe13bb4117cd2b2f7e2c7d489a108`](https://github.com/veresk06/open-ats-feed/commit/01b3908c8a8fe13bb4117cd2b2f7e2c7d489a108), committed **2026-09-05**. The [MIT licence](https://github.com/veresk06/open-ats-feed/blob/01b3908c8a8fe13bb4117cd2b2f7e2c7d489a108/LICENSE) covers its code. Its [README](https://github.com/veresk06/open-ats-feed/blob/01b3908c8a8fe13bb4117cd2b2f7e2c7d489a108/README.md) explicitly presents the project as a coverage measurement, and its CSVs carry historical results rather than a continuously verified source feed.

### A ready candidate directory, with independently checked snapshot arithmetic

All six per-provider committed CSVs were fetched and parsed as data; no upstream code was run. They contain the columns `provider,token,open_postings,board_url,api_url`:

| CSV | Board rows counted | Sum of recorded `open_postings` |
| --- | ---: | ---: |
| [Greenhouse](https://github.com/veresk06/open-ats-feed/blob/01b3908c8a8fe13bb4117cd2b2f7e2c7d489a108/docs/data/greenhouse.csv) | 5,971 | 196,407 |
| [Ashby](https://github.com/veresk06/open-ats-feed/blob/01b3908c8a8fe13bb4117cd2b2f7e2c7d489a108/docs/data/ashby.csv) | 3,413 | 59,609 |
| [Lever](https://github.com/veresk06/open-ats-feed/blob/01b3908c8a8fe13bb4117cd2b2f7e2c7d489a108/docs/data/lever.csv) | 1,925 | 69,565 |
| [Breezy](https://github.com/veresk06/open-ats-feed/blob/01b3908c8a8fe13bb4117cd2b2f7e2c7d489a108/docs/data/breezy.csv) | 2,077 | 41,119 |
| [Recruitee](https://github.com/veresk06/open-ats-feed/blob/01b3908c8a8fe13bb4117cd2b2f7e2c7d489a108/docs/data/recruitee.csv) | 2,444 | 39,628 |
| [Teamtailor](https://github.com/veresk06/open-ats-feed/blob/01b3908c8a8fe13bb4117cd2b2f7e2c7d489a108/docs/data/teamtailor.csv) | 2,334 | 33,539 |
| **Total** | **18,164** | **439,867** |

This verifies the arithmetic in the committed files, **not current liveness, distinct employers, unique vacancies, global coverage or permission to republish source postings**. Multiple board identities may belong to one employer; jobs may overlap. The three ATS platforms already supported locally supply **11,309 historical board candidates** for staged revalidation, subject to region/host support. No candidate was enabled or fetched live in this research.

### Compact modules worth adapting

- [`scripts/harvest-s3.mjs`](https://github.com/veresk06/open-ats-feed/blob/01b3908c8a8fe13bb4117cd2b2f7e2c7d489a108/scripts/harvest-s3.mjs) locates Common Crawl's sorted SURT `cluster.idx` blocks with HTTP HEAD and byte-range binary search, fetches only matching compressed index blocks, gunzips them, extracts board tokens, and checkpoints after each host. This avoids dependence on the CDX query application's uptime; it is a different interface to the same archived index, not proof of broader web coverage.
- [`scripts/harvest-tokens.mjs`](https://github.com/veresk06/open-ats-feed/blob/01b3908c8a8fe13bb4117cd2b2f7e2c7d489a108/scripts/harvest-tokens.mjs) implements the ordinary CDX collection-list/page-count/page walk. Both harvesters share [`scripts/lib/tokens.mjs`](https://github.com/veresk06/open-ats-feed/blob/01b3908c8a8fe13bb4117cd2b2f7e2c7d489a108/scripts/lib/tokens.mjs), which distinguishes path-token ATSes from tenant-subdomain ATSes, drops reserved routes, deduplicates and saves candidate sets. The subdomain parser checks exact vendor suffixes.
- [`scripts/verify-coverage.mjs`](https://github.com/veresk06/open-ats-feed/blob/01b3908c8a8fe13bb4117cd2b2f7e2c7d489a108/scripts/verify-coverage.mjs) probes source endpoints and records live, empty, dead, error and blocked states; its provider pacing separates refusals from missing boards. These are useful fixture-driven patterns for our source validation.
- [`scripts/lib/cc-index.mjs`](https://github.com/veresk06/open-ats-feed/blob/01b3908c8a8fe13bb4117cd2b2f7e2c7d489a108/scripts/lib/cc-index.mjs) exposes range lookup, index-record parsing and archived WARC payload retrieval as a smaller helper. [`scripts/lib/robots.mjs`](https://github.com/veresk06/open-ats-feed/blob/01b3908c8a8fe13bb4117cd2b2f7e2c7d489a108/scripts/lib/robots.mjs) and [the token module's comments](https://github.com/veresk06/open-ats-feed/blob/01b3908c8a8fe13bb4117cd2b2f7e2c7d489a108/scripts/lib/tokens.mjs) document the project's conservative live-plus-historical robots policy. Those historical access observations are not current source approval or a universal interpretation of legal rights.

### Changes required before reuse

1. **Use current archive metadata.** The S3 script's default crawl list starts at `CC-MAIN-2026-04` and contains 2025 snapshots. Select recent snapshots explicitly; record which index/host/block was visited and when, including older snapshots used only to widen candidate recall. [Defaults](https://github.com/veresk06/open-ats-feed/blob/01b3908c8a8fe13bb4117cd2b2f7e2c7d489a108/scripts/harvest-s3.mjs).
2. **Enforce bounded range responses.** The implementation accepts HTTP 200 even after requesting a range, so a server ignoring Range could return an entire object. Validate HTTP 206, Content-Range, expected offsets and byte/decompression limits. [`fetchRange`](https://github.com/veresk06/open-ats-feed/blob/01b3908c8a8fe13bb4117cd2b2f7e2c7d489a108/scripts/harvest-s3.mjs).
3. **Expose partial discovery.** Some range/gunzip failures log and contribute zero while processing continues; this cannot be reported as an exhaustive pass. Persist failed block work for later retry and retain prior candidates on checkpoint corruption. [Block reader](https://github.com/veresk06/open-ats-feed/blob/01b3908c8a8fe13bb4117cd2b2f7e2c7d489a108/scripts/harvest-s3.mjs), [checkpoint loader](https://github.com/veresk06/open-ats-feed/blob/01b3908c8a8fe13bb4117cd2b2f7e2c7d489a108/scripts/lib/tokens.mjs).
4. **Validate identity and public listing scope.** A positive posting count proves an endpoint responded, not that the board belongs to the seed company. Add provenance/ownership checks. The Ashby probe counts all returned jobs; ingestion must still honor `isListed`. Distinguish an unknown response shape from a definitively missing board. [Probe](https://github.com/veresk06/open-ats-feed/blob/01b3908c8a8fe13bb4117cd2b2f7e2c7d489a108/scripts/verify-coverage.mjs).
5. **Integrate our durable state.** Replace local JSON files and sleeping retries with the existing backend directory, due work and persisted backoff. Keep archive harvesting separate from current job polling. Calibrate per-provider limits from current official information and bounded tests.

**Revised first choice:** Revalidate a bounded slice of this committed directory for the supported ATSes, and port the small token/CC-index discovery pattern into our backend. Use Freehire's broader employer-domain traversal and corroboration as the next layer. This reduces initial directory-building work while retaining our existing collector and all-profession scope.


## Recommended reuse sequence

1. Build a provider-neutral candidate schema: employer/domain, discovered URL, provider/board/region, method, source revision/crawl date, evidence, probe result, last attempt and next retry.
2. Start with the ATS platforms already supported locally. Port the **Common Crawl URL extractor + canonical board recognizer + live validation** pattern, and import reviewed existing inventories as additional candidate worklists.
3. Add bounded employer-domain following to widen beyond hosted ATS URLs. Record unresolved/unsupported/custom sites instead of discarding them or inventing their platform.
4. Integrate approved boards with the existing durable collection directory. Distinguish discovered, recognizable-empty, verified-with-jobs, blocked, failed and retired states. Do not auto-expire jobs from a partial discovery or failed fetch.
5. Measure discovery yield by method, new unique employers, valid jobs after normalization, country/profession gaps, refusals, request cost and time to first successful collection. Compare overlap before adding another source family.
6. Add custom-domain JobPosting/sitemap extraction and optional browser/API escalation only for measured residual gaps. Extend source-specific canonicalization and fixtures before widening activation.

## Verification boundary

Verified: canonical Freehire repository link, pinned revisions, selected implementation paths, repository licence texts, discovery flow, committed dataset-file presence, historical shutdown notice and explicit local-copy incompatibilities. Not verified: current employer counts, API liveness, ownership precision, global/non-tech coverage, source access rights for our intended use, provider quotas, crawl yields/costs, deployed worker cadence, or test-suite execution. These require a bounded pilot rather than claims inferred from README inventory totals.

## Implementation follow-up: seed integrity and employer identity

Checked 2026-10-30 after implementation was authorized. Four pinned public CSVs were read as data and hashed; no upstream scripts were executed. Open ATS Feed uses revision `01b3908c8a8fe13bb4117cd2b2f7e2c7d489a108`; LastRound uses `2816bfadd65b7bbec23701dd036bcc7496c729db`.

| Seed file | Bytes / rows | SHA-256 of raw UTF-8 bytes |
| --- | --- | --- |
| Open ATS `docs/data/greenhouse.csv` | 778,842 / 5,971 | `92e20db1359bb1e9f1b8d9729c708b35d8fa6d398e6909c36b57fdc2a5a39a18` |
| Open ATS `docs/data/ashby.csv` | 377,138 / 3,413 | `a47f6ed699467733d01d5648b4b6a22cb11554674194d0d431ee63e3e81aa559` |
| Open ATS `docs/data/lever.csv` | 206,964 / 1,925 | `0199a8ecb1ed541499ca7f58289da740ce3a4a92575bb56cfb48ce5631a06126` |
| LastRound `ats-directory/lastroundai-ats-company-directory-2026-08.csv` | 442,356 / 9,935 | `e637a04d06561bb3839dbf95a291e5fd11ac26b8f2858dc207939c1b723974a3` |

The three Open ATS files have exact header `provider,token,open_postings,board_url,api_url`, no ragged/empty rows, no within-file canonical duplicates, and matching expected board/API hosts and first path segments. LastRound's header is `ats_vendor,company_name,board_slug,last_crawled`; it has 2,856 Ashby, 4,966 Greenhouse and 2,113 Lever rows, no within-file canonical duplicates, 83 uppercase slugs and three numeric slugs. All rows use CSV quoting, so parse CSV rather than split commas. No slugs have surrounding whitespace or invalid slug characters. There are 1,492 rows where `company_name` exactly equals `board_slug`: imported names must remain dataset claims until live evidence confirms them. Dates range from July 11 to August 1, 2026. [Pinned directory](https://github.com/fyrosofttech/lastroundai-hiring-data/blob/2816bfadd65b7bbec23701dd036bcc7496c729db/ats-directory/lastroundai-ats-company-directory-2026-08.csv), [CC BY 4.0 attribution requirement](https://github.com/fyrosofttech/lastroundai-hiring-data/blob/2816bfadd65b7bbec23701dd036bcc7496c729db/LICENSE).

Bounded live reads inspected two public boards and their posting APIs:

- **Ashby n8n:** `https://jobs.ashbyhq.com/n8n` returned HTTP 200 with `<title>` and `og:title` of `n8n Jobs`, exact `og:url`, and an embedded `window.__appData` JSON object. Its `organization` contains `name: "n8n"`, `hostedJobsPageSlug: "n8n"`, an organization UUID and `publicWebsite: "https://n8n.io/"`. The public posting endpoint returned `jobs` and `apiVersion`; it did **not** expose a company-name field. Treat embedded JSON as untrusted data: parse JSON only, never evaluate JavaScript, match the embedded slug to the requested board, and record the hosted-page URL as identity evidence. This embedded shape is observed implementation detail, not an official stable API guarantee. [Hosted board](https://jobs.ashbyhq.com/n8n), [official public API schema](https://developers.ashbyhq.com/docs/public-job-posting-api).
- **Lever:** `https://jobs.lever.co/lever` returned HTTP 200 with `<title>Lever</title>`, `og:title="Lever jobs"` and exact `og:url="https://jobs.lever.co/lever"`. The public API with `limit=1` returned `[]`: this is a legitimate observed empty board, not a missing employer. Lever's documented posting schema has no employer-display-name field. Read root-board metadata, require matching canonical board URL and provider host, and reject generic error/challenge titles. Do not use a job-detail title as the company name or title-case the slug. [Hosted board](https://jobs.lever.co/lever), [official schema and site namespace](https://github.com/lever/postings-api).

For activation, combine provider-published root identity with a correctly shaped listing response and same-provider/same-board posting URLs; Greenhouse can supply a board name through its metadata endpoint. Empty, recognizable boards deserve a separate verified-empty state. A static HTML schema change or blocked request should produce an unresolved/retry state. These two checks do not establish identity precision for the remaining seed rows or current source-wide availability.

