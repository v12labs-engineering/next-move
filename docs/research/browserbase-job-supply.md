# Browserbase for additional job supply

Checked 2026-11-04 against current first-party documentation and this checkout.
The initial assessment did not create browser sessions, use paid APIs, change account
settings, activate sources, publish jobs or deploy code. Incremental job volume
and the configured account's available allowances remain unverified here.

The user subsequently authorized implementation and a bounded live pilot.
See [implementation, paid-project verification and measured additions](../browserbase-discovery.md#verification-and-measured-results)
for the follow-up evidence and release status; the initial baseline below is retained.

## Recommendation

Browserbase can support broader acquisition. The strongest first experiment is
**find new employer sources, then collect through existing ATS readers**. Reserve
full browsers for public career pages whose job links require JavaScript or
interaction. Replacing working JSON feeds with browsers adds work without
establishing additional supply. This is an architectural inference, not a
measured volume claim.

The existing cron provides recurrence. Increasing the number and relevance of
validated sources provides breadth; a faster schedule alone only rechecks the
same source inventory.

## Live baseline from this investigation

Read-only measurement of the configured `job-search-staging` database on
4 November 2026 at approximately 16:15 IST. These observations describe staging;
they do not establish another production database's inventory or user satisfaction.
The keyset scans read catalogue metadata and operational records, without reading
candidate profiles, resumes or descriptions. Multiple requests are not a frozen
database snapshot.

| Measure | Observed result |
| --- | ---: |
| Enabled sources | 7,229 |
| Active listing/location rows | 8,506 |
| Distinct active job URLs across countries | 7,116 |
| Sources with success in the preceding 24 hours | 7,214 |
| Sources currently reporting errors | 15, all HTTP 404 |
| Candidates awaiting review | 3,437 |
| Latest recorded source-expansion run | 30 October; no candidates processed |
| Physical database size / configured collection budget | about 287 MiB / 400 MiB |

The enabled directory contains Ashby (3,054), Greenhouse (2,626), Lever (1,548)
and Arbeitnow (1). It has no enabled Workday, SmartRecruiters or LinkedIn sources,
despite readers existing in the checkout. Discovering and validating employers
in those families is therefore a concrete expansion opportunity, with yield
still unmeasured. Review the existing pending candidates as another intake path;
their review status is not permission to bulk-enable them.

| Country | Distinct active URLs posted in preceding 7 days and checked in preceding 7 days |
| --- | ---: |
| United States | 815 |
| Germany | 248 |
| United Kingdom | 213 |
| India | 157 |
| Singapore | 34 |

These are counts before personal role, experience, city, work-mode and sponsorship
filters. Historical rows may also predate the software-only ingestion policy.
They are upper bounds on useful supply for a candidate within each country, not
matched-job counts. A supplementary read found no active future-dated postings.
URL deduplication removes location variants sharing a URL; distinct cross-posting
URLs may still refer to the same vacancy.

Source runs started on 3 November (UTC) recorded 496 new listing/location records.
This is not a count of 496 unique vacancies or per-user matches. The latest refresh
published 6,032 source snapshots out of 6,047 targets and ended `partial`; a partial
run does not imply that all published snapshots failed. Its preparation record
contains cleanup but no expansion outcome. Combined with the expansion history,
the evidence supports investigating source growth separately from feed refresh.
It does not by itself prove which discovery environment flag is deployed.

Private audit outputs are kept under ignored `.local-data/`:
`job-supply-audit-2026-11-04.json` and
`job-supply-diagnostics-2026-11-04.json`. The read-only scans completed successfully;
no sources were enabled, browser sessions opened or catalogue rows changed.

## What the provider supplies

| Capability | Current documented behavior | Proposed job-supply use |
| --- | --- | --- |
| [Search](https://docs.browserbase.com/platform/search/overview) | Web search returning up to 25 results per query. Search API can return 403 when not enabled. | Discover employer career URLs for underserved role/country segments. Search hits are candidates, not verified current vacancies or a complete market inventory. |
| [Fetch](https://docs.browserbase.com/platform/fetch/overview) | Retrieves raw content, Markdown or schema-shaped JSON; no JavaScript execution, a 5 MB response ceiling and 60-second timeout. Markdown/JSON use a separate Extract meter. | Read static pages and inspect candidates before launching a full browser. Existing native HTTP/ATS readers should remain the default when adequate. |
| Browser plus [Stagehand extract](https://docs.stagehand.dev/v4/basics/extract) | Structured extraction from a rendered page, validated against an output schema. The docs also discuss inconsistent extraction and missing-field handling. | Recover JS-rendered career links or inspect unsupported public job pages. Schema validity does not prove factual correctness, country evidence, or complete pagination. |
| [Observed-action replay](https://docs.stagehand.dev/v4/basics/act) | `observe()` proposes actions; replaying an Action skips inference. With self-healing enabled, a missing selector can trigger reinference. | Bounded navigation through observed career-list pagination, followed by deterministic DOM/JSON extraction where possible. |
| [Managed caching](https://docs.stagehand.dev/v4/best-practices/caching) | Eligible act/observe/extract calls cache server-side; content changes miss the cache. Locator-scoped calls bypass it. | Reduce repeat inference where measured; never use a cached inference result as evidence that a listing was freshly checked. |

Browserbase documents Search → Fetch → Browser as a progressively heavier
retrieval pattern in its [Fetch guide](https://docs.browserbase.com/platform/fetch/overview#when-to-use-fetch).
That supports this staged approach; it does not establish job-market coverage.

## Fit with this repository

- [`discovery/links.ts`](../../lib/server/catalog/discovery/links.ts) already
  scans bounded static career pages, anchors, iframe URLs and embedded ATS URLs.
  It explicitly does not execute JavaScript. A rendered-link fallback fits here.
- [`source-identity.ts`](../../lib/server/catalog/source-identity.ts) recognizes
  observed Ashby, Greenhouse, Lever, SmartRecruiters and Workday board URLs.
  Browser-discovered links should pass through this identity policy and the
  existing candidate validation/activation process, preserving origin evidence.
- [`feeds.ts`](../../lib/server/catalog/feeds.ts) and
  [`additional-ats.ts`](../../lib/server/catalog/additional-ats.ts) already
  implement direct readers. A discovered supported ATS board can therefore add
  recurring supply without a browser for each later refresh.
- The scheduled path is [`workflows/catalog.ts`](../../workflows/catalog.ts) →
  [`sync.ts`](../../lib/server/catalog/sync.ts), using checkpointed collection and
  fenced publication. The newer
  [`source-worker.ts`](../../lib/server/catalog/source-worker.ts) is a separate
  foundation, explicitly not wired into cron yet; see
  [source-task status](../catalog-source-tasks.md). Neither provides a generic
  Browserbase catalogue adapter. Arbitrary custom sites need a reader and
  snapshot contract, not just a configured Browserbase API key.
- [`discovery-search.ts`](../../lib/server/catalog/discovery-search.ts) treats
  filtered observations as incomplete. The same distinction must hold for search
  results, browser windows and capped/infinite-scroll inventories: absence from
  those results cannot establish that a job closed.
- The existing application browser in
  [`applications/browser-session.ts`](../../lib/server/applications/browser-session.ts)
  is separate from catalogue acquisition. New discovery should have its own
  budgets and avoid reducing application capacity.

## Cost and capacity

The current [plans guide](https://docs.browserbase.com/account/billing/plans)
lists Developer at $20/month with 100 browser hours, 25 concurrent sessions and
25 creations/minute; Startup at $99/month with 500 hours, 100 concurrent sessions
and 50 creations/minute. Browser overages are $0.12/$0.10 per hour respectively.
Direct sessions have minute rounding and a one-minute minimum. Paid allocations
can incur overages rather than stopping automatically. Proxy bandwidth and
Fetch/Extract are additional meters. These are published prices, not verification
of this project's plan, remaining allocation, or future bill.

The [Search page](https://docs.browserbase.com/platform/search/overview#providers-and-modes)
lists provider-specific prices ($1/1,000 Parallel fast, $5 advanced and $7 Exa
fast), while the generic plans table lists $7/1,000 Search overage. Confirm the
selected provider's actual meter before estimating spend. Model inference also
needs separate measurement; concurrency improves elapsed throughput, not summed
browser hours. [Session reuse](https://docs.browserbase.com/optimizations/cost/cost-optimization#reusing-sessions)
can avoid repeated session minimums for short tasks.

## Bounded pilot and verification

Proposed parameters, not approved production settings or promised outcomes:

1. Measure current matches by role, country, city and experience; select three
   demonstrably underserved segments. Count active dated jobs in the past seven
   days separately from older and undated observations; exclude future posting
   timestamps from the fresh-job count.
2. Use at most 30 Search queries and 50 candidate career URLs; compare direct
   link discovery against a maximum of ten rendered-page fallbacks. Cap each
   browser at two minutes, two concurrent sessions and 20 summed browser minutes.
   Enforce request, token, proxy and spending caps locally, not just plan quotas.
3. Run in preview or isolated staging. Validate discovered supported ATS boards
   through existing rules. Do not infer locations, dates or sponsorship from the
   search query. Keep unsupported sites as evidence for a later reader decision.
4. Deduplicate against the pre-pilot catalogue by canonical vacancy/application
   identity. Report new employers, validated boards, genuinely new vacancies,
   location variants, refreshed jobs, rejected fields and source failures
   separately. Cross-posting copies must not count as additional supply.
5. Over a proposed seven-day comparison, measure incremental relevant jobs per
   segment/account, share of accounts with no fresh matches, median/p90 age,
   collection completion and total cost per incremental relevant vacancy. Keep
   user profiles/resumes out of provider queries; use aggregate segment terms.
6. Verify pagination boundaries, partial/failed snapshot behavior, duplicate
   handling, source refusal/backoff and budget termination before scheduling the
   pilot collector. Technical reachability does not establish redistribution
   permission; retain existing source-access and provenance policies.

A successful pilot requires verified useful supply beyond the existing pipeline
within an explicit cost budget. Browser session completion, a populated search
response, or a larger raw catalogue count cannot alone establish that users have
enough suitable jobs. No numerical uplift is established by this research.
