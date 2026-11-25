# Tsenta source monitoring: public evidence and scaling model

Research date: 2 November 2026. Scope: first-party public pages and official ATS API documentation. No Tsenta account was accessed, and its crawler or claimed coverage was not independently measured.

## What the number means

Tsenta currently advertises **50,000+ company career pages across 30+ applicant tracking systems**, not 500,000 sources. Its homepage and application guide repeat the career-page claim. These are vendor-reported coverage figures, not an audited count. A company career page can contain many job postings; the public Jobs page's job count is a separate metric and cannot establish source coverage. [Homepage](https://tsenta.com/), [application guide](https://help.tsenta.com/how-tsenta-applies-to-jobs), [Jobs](https://tsenta.com/jobs)

Its freshness guide says it monitors employer pages directly, rather than waiting for job-board republication. Auto Apply runs one to four times per day; the defaults are 5 AM, 11 AM, 5 PM and 11 PM Eastern, approximately an hour after regular job refreshes. This suggests a roughly six-hour regular refresh rhythm, but does **not** establish the polling interval or achieved freshness of every career page. The guide explicitly qualifies application timing as generally within hours, without a universal minutes-after-posting guarantee. [Freshness guide](https://help.tsenta.com/how-fast-tsenta-applies)

Some marketing is stronger: the international-student page describes continuous monitoring and detection-to-submission in seconds. That conflicts with interpreting the help guide as an instant service guarantee. Neither page supplies a measured posting-to-detection latency distribution or per-source refresh evidence. [International-student marketing](https://tsenta.com/international), [freshness guide](https://help.tsenta.com/how-fast-tsenta-applies)

## How this scale can work

The following is an engineering explanation, **not a disclosure of Tsenta's private implementation**:

1. Maintain a directory of employer career URLs and their ATS board identifiers.
2. Reuse an adapter for each ATS family across many employer boards. Greenhouse, for example, documents an unauthenticated GET endpoint that lists a board's published jobs, optionally including full descriptions. Ashby documents a GET endpoint that returns an organization's published job postings as JSON. One such request can supply many listings without opening a browser for each job. [Greenhouse Job Board API](https://docs.greenhouse.io/job-board), [Ashby Job Postings API](https://developers.ashbyhq.com/docs/public-job-posting-api)
3. Use queued, bounded workers to distribute due boards, enforce per-host limits, paginate large inventories, checkpoint failures and retry later. Store stable IDs/content hashes so unchanged listings do not repeatedly trigger expensive enrichment or matching. Render a browser only where the source requires it. These are proposed design choices, not verified Tsenta components.
4. Collect a shared catalogue once, then match many users against it. Tsenta documents a resume/preferences-ranked match feed; the shared-ingestion architecture is an inference, not public implementation evidence. [Application guide](https://help.tsenta.com/how-tsenta-applies-to-jobs)

For a simplified capacity illustration, checking 50,000 boards once every six hours means 200,000 board checks per day, averaging **2.31 checks per second** across the day. At 500,000 boards it would be 2,000,000 checks per day, averaging **23.15 per second**. Actual HTTP request counts, concurrency, bandwidth and cost can be much greater because of pagination, detail reads, retries, browser rendering and host limits. These are arithmetic examples, not Tsenta measurements or a capacity claim for this repository.

## What remains unknown

The reviewed public material does not establish Tsenta's exact employer discovery method, source directory, ingestion vendors or feed partnerships, queue technology, cloud provider, worker count, conditional-request strategy, crawl success rate, or operating cost. Supporting an ATS for **submitting applications** also does not prove every employer using it is discovered or refreshed. No evidence found supports attributing a specific commercial job-data provider to Tsenta.

The useful implementation lesson is to measure **verified active sources, successful refresh coverage and posting-to-discovery age**, rather than treating a large imported URL directory as fresh supply. The six-hour scheduler is only an admission cadence; finishing a complete sweep within that period must be observed separately.
