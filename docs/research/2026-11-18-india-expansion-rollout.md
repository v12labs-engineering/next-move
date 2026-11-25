# Local India source expansion — 18 November 2026

**14 newly activated sources completed collection and added 721 new unique India jobs. The active unique India catalog now contains 14,258 jobs; 14,141 have posting dates within the preceding 30 days.**

This was completed only in local Docker project `job-search-drill-9sbub4-restored`, at `http://127.0.0.1:3302`. No Vercel operations were performed. Snapshot: **18 November 2026, 13:12:27 IST** (`2026-11-18T07:42:27.526489+00:00`). Baseline: `2026-11-18T06:37:13.643618+00:00`.

| Newly activated source | Additional unique India jobs |
| --- | ---: |
| Deloitte India | 541 |
| Barclays India | 113 |
| SAP IT Business Systeme | 18 |
| Renesas Electronics | 14 |
| Sutherland | 9 |
| WNS | 6 |
| KeyValue | 6 |
| MicroStrategy | 5 |
| IFS | 2 |
| Mindera | 2 |
| Zyte | 2 |
| Entain | 1 |
| YouTrip | 1 |
| Thinkbridge | 1 |
| **Expansion total** | **721** |

## Reconciliation

| Measure | Unique India jobs |
| --- | ---: |
| Baseline active catalog | 13,463 |
| Added by these 14 sources | +721 |
| Added by other collection during the rollout | +175 |
| Previously inactive jobs reactivated | +6 |
| Existing active jobs closed during refresh | −107 |
| **Final active catalog** | **14,258** |
| **Net active increase** | **795** |

All **721 expansion additions** have full descriptions, explicit India location evidence, and provider posting dates within 30 days. They were absent from every baseline catalog identity, including inactive rows and other countries. None are reactivations or shared new-source/existing-source identities. Deloitte's live publication returned three more eligible jobs than its earlier 538-job preview.

The 175 additions from other collection comprise 79 fresh jobs and **96 future-dated Adzuna India records**. Those future timestamps are retained as observed and excluded from the fresh 30-day total; no timezone correction was guessed. Across the final active inventory, 20 additional identities are older than 30 days and one has no posting date. Thus the active total and the fresh total are deliberately separate measures.

## Collection and verification

- Added fixed, reviewed public readers for [Deloitte India](https://southasiacareers.deloitte.com/go/Deloitte-India/718244/) and [Barclays India](https://search.jobs.barclays/location/india-jobs/13015/1269750/2/1). Deloitte completed 87 pages; Barclays completed 22. Readers check full descriptions, exact dates, employer identity, India addresses, pagination, canonical URLs, and provider backoff.
- Activated 12 additional verified career boards through existing SmartRecruiters, Workable and Zoho readers. SmartRecruiters India country filters were persisted before activation. SAP's official site and application link establish its `SAP IT Business Systeme` board identity.
- Narrowly expanded technical consultant classification for implementation-backed .NET and Power Platform roles. The collector covers all supported job families; users continue to choose categories in their profiles.
- Applied local migrations 086–088 after a local PostgreSQL backup. A safe lock timeout rolled back the first 087 attempt; the retry committed successfully. Migration 090 and the runtime reliability fixes belong to the coordinated Docker-repair chat.
- Coordinated one combined app/scheduler deployment with that chat. The deployed reader, category and requisition-deduplication hashes match the tested workspace. Both containers were healthy at final verification.
- Used the existing fenced source-task pipeline. Request-budget handoffs resumed saved pages. Two Zoho publication attempts encountered database lock timeouts, then completed from their saved snapshots without fetching those pages again. All 14 publication receipts are complete and their sources remain enabled.
- The 12 ATS sources have 3,300-second intervals. Deloitte and Barclays have 2,700-second intervals to allow full scan time within an hourly cycle. At the final system check, the broader 428-source India pool had no pending tasks, three stale sources and two failed sources; all 14 sources in this expansion had succeeded.
- 52 distinct connector, category, deduplication and watchdog regressions were covered by passing runs, plus 10 isolated Docker measurement checks. Production build, TypeScript, focused lint, migration fixtures and diff checks passed.

Canonical application URL and provider requisition identity audits agree on both additions and inventory. The audit preserves all source provenance and excludes baseline inactive/global identities. Distinct requisition IDs survive identical company/title/location labels. It does not claim to identify every cross-site advertisement using an unrelated application URL.

Qualcomm remains inactive after repeated HTTP 429 responses. Its partial preview is excluded. Other held providers, incomplete inventories and restricted feeds are documented in the research notes and contributed no counted additions.

## Evidence

- [Machine-readable rollout receipt](../../.local-data/rollouts/2026-11-18-india-expansion/receipt.json)
- [Unique-job measurement and every added posting](../../.local-data/rollouts/2026-11-18-india-expansion/measurement.json)
- [Identity audit and regression coverage](../../.local-data/rollouts/2026-11-18-india-expansion/IDENTITY-AUDIT.md)
- [Direct-employer research: Barclays, Qualcomm and held leads](2026-11-18-india-direct-employer-research.md)
- [Deloitte and Workday research](2026-11-18-india-workday-oracle.md)
- [Career-board and job-board research](2026-11-18-india-jobboards-ats.md)

The private rollout directory retains frozen before/after snapshots, backup checksum, source proofs, exact activations, task receipts, deployment hashes, quality counters and reproducible measurement scripts. Collection and matching did not submit account applications.
