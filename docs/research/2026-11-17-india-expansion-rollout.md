# Local India source expansion — 17 November 2026

Completed in local Docker project `job-search-drill-9sbub4-restored`, origin `http://127.0.0.1:3302`. No Vercel actions were performed.

**45 newly activated, verified sources completed collection and added 1,364 new unique India postings. The final active unique India catalog contains 13,036 jobs.** Measurement froze at `2026-11-17T13:31:38.826708+00:00` (19:01 IST); baseline was `2026-11-17T12:45:31.313832+00:00`.

| Added source | Additional unique India jobs |
| --- | ---: |
| IBM | 1,029 |
| JPMorgan Chase | 97 |
| Emerson | 32 |
| Nokia | 28 |
| 41 other verified career boards | 178 |
| **Expansion total** | **1,364** |

## Reconciliation

| Measure | Unique India jobs |
| --- | ---: |
| Baseline active catalog | 11,666 |
| Added by the 45 expanded sources | +1,364 |
| Added by existing scheduled sources during the rollout | +9 |
| Existing listings closed during refresh | −3 |
| **Final active catalog** | **13,036** |

All 1,373 newly added identities have provider posting dates within the preceding 30 days. Reactivations and jobs already present elsewhere in the baseline are excluded from additions. Application URLs are canonicalized and then cross-checked using the platform's provider requisition identity rules; both methods agree. Equal company/title/city labels do not merge different requisition IDs. The count is not a claim that every semantically similar vacancy advertised at an unrelated URL can be identified automatically.

## Implemented and verified

- Expanded Keka coverage to default public career portals while preserving employer-domain checks and the existing GUID portal path.
- Added verified Oracle tenants for JPMorgan Chase, Nokia, and Emerson with strict India, full-description, pagination, and posting-date checks.
- Added IBM's public career-search connector. It collected all 22 pages and 2,152 distinct recent India source requisitions; 1,029 eligible postings were published, with full descriptions and no duplicate rows. Optional metadata and stable identifier sorting are regression-covered.
- Corrected five narrow technical specialist/consultant title families using discipline-specific implementation evidence. This recovered 249 eligible IBM postings while preserving functional finance, generic consulting, and presales exclusions. Categories remain user-profile settings.
- Applied migrations 084 and 085 atomically to the local database after a database backup. Their schema changes do not activate sources by themselves.
- All 45 publication tasks completed. All sources are enabled with 3,300-second collection intervals and qualify for the existing hourly India scheduler. The restart-interrupted older Oracle refresh resumed and completed before the final measurement.
- At the final check, all 407 verified India sources had succeeded within the last hour: zero stale, failed, waiting, or pending India tasks; one ordinary scheduled refresh was running.
- 70 Docker regression tests passed across connector, category, and requisition-deduplication checks. Production build, TypeScript, focused lint, migration fixtures, and diff checks passed. Runtime reader/classifier/deduplication hashes match the tested workspace.

Honeywell remains disabled because a selected posting lacks full content. Throttled Workday feeds and reviewed agency/geography/category conflicts were not counted as successful sources.

## Evidence

- [Machine-readable rollout receipt](../../.local-data/rollouts/2026-11-17-india-expansion-2/current/receipt.json)
- [Unique-job measurement, including every added posting](../../.local-data/rollouts/2026-11-17-india-expansion-2/current/measurement.json)
- [IBM primary-source research](2026-11-17-ibm-careers-api.md)
- [Oracle and Workday primary-source research](2026-11-17-india-expansion-workday-oracle.md)
- [ATS primary-source research](2026-11-17-india-expansion-ats.md)
- [Keka and Zoho primary-source research](2026-11-17-india-expansion-boards.md)

The private rollout directory also retains frozen before/after snapshots, backup checksum, exact activation definitions, task and publication receipts, build/test logs, and reproducible operator/measurement scripts. No account applications were submitted as part of this expansion.
