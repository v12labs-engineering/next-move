# India ATS expansion — 17 November 2026

Read-only verification completed at `2026-11-17T12:52:24.524Z` against local Docker inventory captured at `2026-11-17T12:46:09.493955+00:00`. No source activation, catalog publication, migrations, or remote deployment was performed by this research pass.

**29 additional employer boards passed complete strict-reader preflight, containing 87 fresh India posting URLs.** These are candidate inventory counts, not additional unique jobs already added. The main workflow must compare canonical job identities and measure committed publication before reporting additions.

## Method and scope

Queried `job_source_directory` and `source_candidates` in the local restored Docker stack. Imported Ashby, Greenhouse, Lever, SmartRecruiters and Workable candidates had only three unenabled entries: `greenhouse:embed` (missing), `greenhouse:zafinlabsamericasinc` (legal-name review), and `smartrecruiters:harimalcorporationpvtltd` (empty). The thousands of already enabled boards were excluded before network validation.

Searched first-party employer ATS pages, then used the repository's `validateCandidate`, `probeClient`, and `fetchCatalogPage` readers with all configurable job categories. Each recommended board completed pagination, passed identity/location/content checks, and had at least one accepted India posting dated within the preceding 30 days and not in the future. Unknown posting dates were not counted as fresh; none of the recommended fresh India counts rely on unknown dates. Results were deduplicated by posting URL within each board. Descriptions were reviewed for employer and geography conflicts. Search crawl dates were never substituted for posting dates.

Tested 48 previously unenabled source identities. Exact source configuration, provider evidence, normalized posting dates and job IDs are in `ready.json`; completed and failed probes are retained in `preflight.json`. All 29 recommended boards use `config: {}`; their source ID and board token below are exact.

## Ready employer batch

| Source ID | Provider company | Fresh India URLs | Accepted India inventory | Primary API evidence |
| --- | --- | ---: | ---: | --- |
| `workable:prox-works` | Proximity Works | 15 | 20 | [Live provider feed](https://apply.workable.com/api/v1/widget/accounts/prox-works?details=true) |
| `workable:lokal-app` | Lokal App | 11 | 38 | [Live provider feed](https://apply.workable.com/api/v1/widget/accounts/lokal-app?details=true) |
| `workable:cloudstuff` | Trackier | 7 | 10 | [Live provider feed](https://apply.workable.com/api/v1/widget/accounts/cloudstuff?details=true) |
| `workable:jove` | JoVE | 6 | 8 | [Live provider feed](https://apply.workable.com/api/v1/widget/accounts/jove?details=true) |
| `ashby:firstwork` | Firstwork | 5 | 7 | [Live provider feed](https://api.ashbyhq.com/posting-api/job-board/firstwork) |
| `workable:mercari-india` | Mercari, Inc. (India) | 4 | 11 | [Live provider feed](https://apply.workable.com/api/v1/widget/accounts/mercari-india?details=true) |
| `workable:velsera` | Velsera | 4 | 4 | [Live provider feed](https://apply.workable.com/api/v1/widget/accounts/velsera?details=true) |
| `workable:zenara-health` | Zenara Health | 4 | 4 | [Live provider feed](https://apply.workable.com/api/v1/widget/accounts/zenara-health?details=true) |
| `workable:koru` | Koru UX Design LLP | 3 | 4 | [Live provider feed](https://apply.workable.com/api/v1/widget/accounts/koru?details=true) |
| `workable:leucine` | Leucine | 3 | 5 | [Live provider feed](https://apply.workable.com/api/v1/widget/accounts/leucine?details=true) |
| `greenhouse:zafinlabsamericasinc` | Zafin | 2 | 5 | [Live provider feed](https://boards-api.greenhouse.io/v1/boards/zafinlabsamericasinc/jobs?content=true) |
| `workable:exponent-energy` | Exponent Energy | 2 | 9 | [Live provider feed](https://apply.workable.com/api/v1/widget/accounts/exponent-energy?details=true) |
| `workable:fairmoney` | FairMoney | 2 | 2 | [Live provider feed](https://apply.workable.com/api/v1/widget/accounts/fairmoney?details=true) |
| `workable:mydbsync` | DBSync Inc | 2 | 3 | [Live provider feed](https://apply.workable.com/api/v1/widget/accounts/mydbsync?details=true) |
| `workable:nowverticalgroup` | NowVertical | 2 | 4 | [Live provider feed](https://apply.workable.com/api/v1/widget/accounts/nowverticalgroup?details=true) |
| `workable:pmc-commerce` | PMC Commerce | 2 | 4 | [Live provider feed](https://apply.workable.com/api/v1/widget/accounts/pmc-commerce?details=true) |
| `workable:ai-accountant` | AI Accountant | 1 | 3 | [Live provider feed](https://apply.workable.com/api/v1/widget/accounts/ai-accountant?details=true) |
| `workable:awesomemotive` | Awesome Motive | 1 | 1 | [Live provider feed](https://apply.workable.com/api/v1/widget/accounts/awesomemotive?details=true) |
| `workable:crop-photo-at-evolphin` | Crop.photo | 1 | 3 | [Live provider feed](https://apply.workable.com/api/v1/widget/accounts/crop-photo-at-evolphin?details=true) |
| `workable:deltaexchange` | Delta Exchange | 1 | 3 | [Live provider feed](https://apply.workable.com/api/v1/widget/accounts/deltaexchange?details=true) |
| `workable:docyt` | Docyt | 1 | 2 | [Live provider feed](https://apply.workable.com/api/v1/widget/accounts/docyt?details=true) |
| `workable:fortanix` | Fortanix | 1 | 9 | [Live provider feed](https://apply.workable.com/api/v1/widget/accounts/fortanix?details=true) |
| `workable:innovationteam` | InnovationTeam | 1 | 3 | [Live provider feed](https://apply.workable.com/api/v1/widget/accounts/innovationteam?details=true) |
| `workable:intellectsoft` | Intellectsoft | 1 | 1 | [Live provider feed](https://apply.workable.com/api/v1/widget/accounts/intellectsoft?details=true) |
| `workable:marketnode` | Marketnode | 1 | 2 | [Live provider feed](https://apply.workable.com/api/v1/widget/accounts/marketnode?details=true) |
| `workable:teleport-careers` | Teleport | 1 | 2 | [Live provider feed](https://apply.workable.com/api/v1/widget/accounts/teleport-careers?details=true) |
| `workable:unisongroup` | Unison Group | 1 | 21 | [Live provider feed](https://apply.workable.com/api/v1/widget/accounts/unisongroup?details=true) |
| `workable:updraft` | Updraft | 1 | 1 | [Live provider feed](https://apply.workable.com/api/v1/widget/accounts/updraft?details=true) |
| `workable:zealgroup` | Zeal Group | 1 | 8 | [Live provider feed](https://apply.workable.com/api/v1/widget/accounts/zealgroup?details=true) |

Accepted India inventory includes older postings; the fresh column is the relevant preview for new collection under the 30-day policy. Existing published jobs may be refreshed even when their original posting date is older. The aggregate 87 is not a promise of 87 new unique database rows.

## Zafin identity review

The imported candidate was held because its historical legal label, Zafin Software Centre of Excellence Private Limited, differs from the current board brand, Zafin. Zafin's own corporate statement names both that Indian legal entity and Zafin Labs Americas Incorporated; this supports reviewing the mismatch as a group legal-name variation rather than unrelated employer identity. The live Greenhouse board explicitly identifies Zafin and has fresh India engineering and product-marketing vacancies. [Zafin corporate statement, page 1](https://zafin.com/wp-content/uploads/2025/01/Zafin-Modern-Slavery-Statement-2023-UK-Final.pdf), [Zafin employer board](https://job-boards.greenhouse.io/zafinlabsamericasinc).

Two accepted fresh examples: [Lead Java Developer in Trivandrum](https://job-boards.greenhouse.io/zafinlabsamericasinc/jobs/5209608007) and [Senior Product Marketing Specialist in Chennai](https://job-boards.greenhouse.io/zafinlabsamericasinc/jobs/5262953007). The root rollout should persist its identity review when resolving the existing candidate hold.

## Staffing listings need an accurate agency display

Staffing sources are within the requested coverage. These holds concern how the current platform identifies the employer, not a blanket exclusion of job boards or agencies. The Workable reader writes the account name into the ordinary `company` field, with no separate posting-agency indicator. A source-directory company override cannot resolve this because the reader takes the employer label directly from the provider account.

- `workable:weekday-1`: 57 fresh India postings; all 57 explicitly refer to an unnamed Weekday client after Unicode NFKC normalization. Examples are [Academic Consultant sales](https://apply.workable.com/j/C26A3B7587) and [AI Architect](https://apply.workable.com/j/8DBC9B0180). Publishing the current normalized company, Weekday AI, as the hiring employer would lose that distinction. Preserve this as a presentation/data-model review, then revisit activation if the posting agency is identified accurately.
- `workable:gsstech-group`: 6 fresh India postings. The [Genesys role](https://apply.workable.com/j/B6D85EA051) is advertised on behalf of an unnamed enterprise client; the [Storage & Data Protection role](https://apply.workable.com/j/1AD3514EB4) explicitly identifies GSS as a staffing/managed-workforce partner and describes Bangalore work for an unnamed UAE bank. The latter confirms India location despite the client's country. Normalized company currently remains GSSTech Group without agency labeling. Full job-level evidence is in `agency-review.json`.

Consultancies advertising their own team roles were retained, including InnovationTeam, Koru UX Design, Intellectsoft and Unison Group's own inside-sales role. Mentioning customers in a consulting job is not by itself a hold.

## Not ready and further leads

- `smartrecruiters:mattelinc`: provider identity verified, but both global and India-scoped strict collection fail on an incomplete posting. Do not activate as a complete inventory until the underlying data can pass the existing reader. First-party discovery: [Mattel India software-engineering role](https://jobs.smartrecruiters.com/MattelInc/744000159341609-sr-software-engineer).
- `smartrecruiters:visa`: public endpoint currently returns no postings; a retained careers-page search result is insufficient evidence of a collectable feed. [Visa's retained SmartRecruiters careers page](https://careers.smartrecruiters.com/Visa/vca-consultants).
- `ashby:skyflow` returned 404; `ashby:nanonets` and `workable:reveal-health-tech` returned empty inventories despite indexed pages. These demonstrate why search counts are not publication evidence.
- Other complete boards in `preflight.json` have no fresh accepted India postings. They are not included in the ready batch.
- Palo Alto Networks' first-party India careers site shows relevant positions, but the inspected job link redirected to its general careers landing page. No supported ATS identity or complete fresh feed was established in this pass. [Official India careers page](https://jobs.paloaltonetworks.com/en/india/).

## Artifacts

- `.local-data/rollouts/2026-11-17-india-expansion-2/ats/inventory.json` — initial local source/candidate inventory.
- `evidence.json` — primary discovery URLs.
- `probe.mts` and `probe.log` — reproducible read-only checks and outcomes.
- `preflight.json` — all 48 results, completed reader counts and rejection reasons.
- `ready.json` — 29 exact source definitions and 87 fresh India posting previews.
- `agency-review.json` — 63 staffing postings and attribution concerns.
