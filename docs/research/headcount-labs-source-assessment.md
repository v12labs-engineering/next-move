# Headcount Labs as a supplemental job source

Research date: 1 November 2026. First-party documentation and current repository source only. No signup, purchase, bulk download, API credential creation or ingestion was performed. Provider counts and freshness statements below are published claims, not measurements from this assessment.

## Recommendation

**Superseded by the user's clarified direction:** do not integrate the Headcount API. Study how they acquire jobs directly and improve our own collector. See [Headcount acquisition method](headcount-acquisition-method.md). The assessment below is retained as research evidence, not authorization or a recommendation to implement that integration.

The initial research considered the live API as a supplemental discovery source alongside our existing direct ATS APIs. That option is outside the clarified scope. No API integration was implemented.

Our collector's default configurable database budget is 400 MiB (`lib/server/catalog/sync.ts`), which favors targeted ingestion over a full mirror. The live API was not called during this assessment; this recommendation rests on documented capabilities.

## What the linked repository provides

The repository describes an October 19 snapshot of approximately 8.4 million jobs, but says the full download is private/coming soon. It contains documentation, examples and a 1,000-row sample, with public subsets linked on Hugging Face. The snapshot omits job-description text; the live API supplies descriptions and current searches. The full dataset Hugging Face URL returned 401 through the web tool during this assessment. Availability of every public subset was not verified. [Repository](https://github.com/HeadcountLabs/job-postings), [dataset URL](https://huggingface.co/datasets/HeadcountLabs/job-postings).

## Coverage and freshness

The dated coverage page reports 8.7 million jobs across 241 countries and 131 platforms on October 21, including 243,704 in India. That supports evaluating global rather than US-only coverage; it does not establish current counts or relevance to a particular candidate. Locations can place the same job under multiple countries. [Coverage](https://headcountlabs.com/coverage/).

The lifecycle model separates job `currentness`, posting `posting_status`, application availability checks and `stale`. A job may be uncertain, or lack an application check; those states must not be flattened into confirmed open/closed. The changes feed emits created/updated jobs and expired IDs; single-job responses distinguish merges (308), withdrawals (410) and unknown IDs (404). Source posting dates, first-seen dates, last complete source fetch and provider-update dates describe different events. [Lifecycle](https://headcountlabs.com/docs/job-lifecycle/).

The provider recommends initial filtered ingestion followed by `/v1/jobs/changes`, storing the cursor after durable writes and replaying idempotently by job/event ID. It claims daily job rechecks and suggests polling changes every 15–60 minutes. This is not evidence of minute-level source freshness. [Ingestion strategy](https://headcountlabs.com/docs/ingestion-strategy/).

## API and limits

- Pricing advertises 100,000 delivered records per organization per UTC calendar month free, no card. Additional records cost $0.01 per 1,000 after explicit paid enrollment; the free account stops when exhausted. Repeated deliveries, company records and changes events count again. Counts/errors/empty results do not consume records. Full-catalogue sync can involve many more records than a single snapshot. [Pricing](https://headcountlabs.com/pricing/).
- New free accounts have 30 requests/minute and 1,000 requests/UTC day across keys; paid accounts have 60/minute and no daily request cap. REST job pages support up to 250 records (1,000 for ID-only output), changes pages up to 1,000 events. Respect `Retry-After` and usage headers. [Rate limits](https://headcountlabs.com/docs/rate-limits/).
- Public MCP is suitable for evaluation: six read-only tools, no key, up to 250 results per search; pages up to 50, or 10 with full descriptions. It has 20 calls/minute and 1,000/day per conversation, network limits and a shared site budget. It is not a dependable production ingestion contract. Authenticated MCP/REST share account usage. [MCP](https://headcountlabs.com/mcp/).
- **Documentation conflict:** pagination says default updated-order list cursors survive new publications, while the ingestion guide says publication invalidates a snapshot-pinned cursor. Verify actual behavior before implementing recovery; preserve stable filters/page size, durable checkpoints and idempotent restart capability. [Pagination](https://headcountlabs.com/docs/pagination/), [ingestion](https://headcountlabs.com/docs/ingestion-strategy/).

Live fields include description, source/application URLs, source posting IDs, canonical job/company IDs, multiple locations and source-provenance wrappers. `known`, `derived`, omitted and failed extraction are separate states. Preserve these distinctions; derived values must not become employer-confirmed evidence. [Field dictionary](https://headcountlabs.com/docs/fields/).

## Reuse constraints

The provider explicitly applies the same ODbL 1.0 database license to downloads, API and MCP. It permits commercial use, requires credit for public use and describes share-alike for published databases made from its data. Its own derived values use DbCL. Employer descriptions, names/logos and personal data have separate rights; Headcount Labs does not license those on the employer's behalf. Removed material is excluded from later releases. These are the provider's stated terms, not a conclusion about the precise obligations of our combined catalogue. Decide the data boundary and attribution before public integration. [Data licence](https://headcountlabs.com/license/), [terms](https://headcountlabs.com/terms/).

## How we source jobs now

The main shared catalogue already uses direct JSON APIs in [feeds.ts](../../lib/server/catalog/feeds.ts): Greenhouse `boards-api.greenhouse.io/v1/boards/{board}/jobs?content=true`, Ashby `api.ashbyhq.com/posting-api/job-board/{board}`, Lever `api.lever.co/v0/postings/{board}?mode=json`, and Arbeitnow's job-board API. This is distinct from HTML/browser scraping.

Enabled sources come from the database directory. Candidate employer boards are seeded from attributed Open ATS Feed/LastRound directories, then validated before activation; directory rows are not themselves live vacancies. See [seed imports](../../lib/server/catalog/discovery/seeds.ts) and [validation](../../lib/server/catalog/discovery/validate.ts). A separate operator sponsor-source pipeline can crawl employer pages through [the collection route](../../app/api/sources/collect/route.ts). The cloud browser application runner fills employer forms; it is not the main catalogue collector. No live source/job counts or scheduler execution receipts were checked here.

## Small evaluation before an adapter

1. Compare bounded country/role queries against existing catalogue results: genuinely new jobs, duplicates, source ages, missing descriptions and application destinations.
2. Retain provider job/posting IDs plus original ATS identity to reconcile overlap without replacing our stable saved-job/application links.
3. Normalize field states and dates honestly; preserve source attribution and provider observation times.
4. Check pagination and expiry behavior, merges, retries and deduplication using recorded fixtures; never let a partial search expire an employer's whole inventory.
5. Establish a separate source provenance/license boundary and usage budget. Start within the free allowance without enabling overage.
6. Reuse existing durable publication/storage guards after the mapping and lifecycle tests pass. A documented capability or successful API response alone is not a completed integration.
