# India job boards and employer ATS research — 18 November 2026

## Result

**12 new employer feeds passed complete strict preflight and attribution review, supplying 67 fresh, unique India jobs.** Another 26 technically valid staffing-role postings are held pending clear agency presentation. These are preview supply counts, not database additions. This subtask made no database writes or source activations. The rollout owner must measure actual new canonical jobs after collection.

The baseline is `.local-data/rollouts/2026-11-18-india-expansion/source-inventory.json`. None of the ready source IDs was enabled in that captured baseline. The executable handoff is `.local-data/rollouts/2026-11-18-india-expansion/boards/ready-final.json`; it includes canonical source IDs, exact configs, provider verification, complete pagination, all accepted job URLs and dates, and review notes.

| Source ID | Provider employer identity | Config | Strict pages | Fresh India unique jobs | Evidence |
|---|---|---|---:|---:|---|
| `smartrecruiters:sapitbusinesssysteme` | SAP IT Business Systeme | `{"country":"IN"}` | 2 | 18 | [Official evidence](https://jobs.sap.com/en/jobs/744000159293423/senior-backend-software-engineer-java/) |
| `smartrecruiters:renesaselectronics` | Renesas Electronics | `{"country":"IN"}` | 3 | 14 | [Official evidence](https://jobs.smartrecruiters.com/RenesasElectronics/744000155439974-sr-staff-engineer-design-verification) |
| `smartrecruiters:sutherland` | Sutherland | `{"country":"IN"}` | 1 | 9 | [Official evidence](https://jobs.smartrecruiters.com/Sutherland/744000146893410) |
| `smartrecruiters:wnsglobalservices144` | WNS Global Services | `{"country":"IN"}` | 2 | 6 | [Official evidence](https://jobs.smartrecruiters.com/WNSGlobalServices144/744000039363475) |
| `zohorecruit:keyvalue.zohorecruit.in` | KeyValue Software Systems | `{}` | 1 | 6 | [Official evidence](https://keyvalue.zohorecruit.in/jobs/Careers) |
| `smartrecruiters:microstrategy1` | MicroStrategy | `{"country":"IN"}` | 1 | 5 | [Official evidence](https://jobs.smartrecruiters.com/MicroStrategy1/744000157734739-product-owner-ai) |
| `workable:minderacraft` | Mindera | `{}` | 1 | 2 | [Official evidence](https://apply.workable.com/minderacraft/) |
| `workable:zyte` | Zyte | `{}` | 1 | 2 | [Official evidence](https://apply.workable.com/zyte/) |
| `smartrecruiters:ifs1` | IFS | `{"country":"IN"}` | 1 | 2 | [Official evidence](https://jobs.smartrecruiters.com/ifs1/744000160579830-technical-onboarding-engineer-ifs-logistics) |
| `workable:youtrip` | YouTrip | `{}` | 1 | 1 | [Official evidence](https://apply.workable.com/youtrip/) |
| `smartrecruiters:entain` | Entain | `{"country":"IN"}` | 1 | 1 | [Official evidence](https://api.smartrecruiters.com/v1/companies/entain/postings) |
| `zohorecruit:thinkbridge.zohorecruit.in` | thinkbridge | `{}` | 1 | 1 | [Official evidence](https://thinkbridge.zohorecruit.in/jobs/Careers) |

## Verification

Read-only Node24 containers ran the repository's existing `validateCandidate` and `fetchCatalogPage` readers, with all eight profile categories selected. Each source used one fixed observation time and a 30-day freshness cutoff. SmartRecruiters was explicitly scoped to `country=IN`, `destination=PUBLIC`, and the reader's fixed `releasedAfter` window. All pages were drained; no arbitrary first-page count is reported as complete. Dates after the observation time were excluded. Full descriptions, exact provider company/location, and canonical URLs were saved. Unique means one canonical posting URL within India; Workable's duplicate city entries for one shortcode are counted once.

Evidence files live under the boards directory: `preflight.json`, `extra-preflight.json`, `zoho-preflight.json`, `*-fresh-details.json` and `*-responses.json`. `probe.ts` contains the reproducible existing-reader harness. The first generic duplicate-URL check rejected Workable's legitimate multiple-location entries; this harness-only check was removed, and YouTrip/Zyte were rerun successfully in `extra-preflight.json`. The canonical reader's conflicting-content guard remained unchanged. No application reader or classifier was changed in this research pass.

SAP's corporate [careers URL](https://www.sap.com/about/careers.html) redirects to `https://jobs.sap.com/en/?locale=en_US`, and its public careers Apply link establishes the exact `sapitbusinesssysteme` board identity; it is not a guessed `sap` alias. The provider company label is **SAP IT Business Systeme**. [SAP official role](https://jobs.sap.com/en/jobs/744000159293423/senior-backend-software-engineer-java/). `sap-identity-evidence.json` records the exact Apply target. Web-reader primary pages/clicks verified the chain; the separate Docker HTML save received 403, which was recorded without bypass. The public SmartRecruiters API itself returned 200 throughout the complete preflight.

SA Technologies publishes consulting/staffing project roles, including client-system references. All 26 fresh accepted roles were reviewed for actual software/data/product work and India location evidence, but this does not establish direct SA employment. **The rollout owner correctly held this cohort until the product can explicitly show agency attribution.** They are preserved separately in `held-staffing.json` and excluded from ready supply; a company label alone is insufficient to imply direct-employer hiring.

## Held and empty sources

- **Mattel:** the API confirms Hyderabad engineering roles, but current software requisition `744000159341609` has all description sections empty. Strict collection fails, so the source is held rather than silently dropping incomplete eligible inventory.
- **Sia:** four fresh jobs pass mechanically, but `Senior Data Analyst (Hyderabad)` has structured city `Kurnool`. Held for contradictory exact location; three other jobs were not activated as a manual ID exception.
- **Swiggy:** 46 jobs pass category-title classification, but most are restaurant sales/account management or travel-category sales/operations. Held because that would broaden the requested software-adjacent scope.
- **Visa:** the official old SmartRecruiters career page and current API return no public postings; not counted. T-Systems ICT India and Hitachi Solutions completed but produced zero accepted fresh India jobs.
- **Rapyuta Robotics, Navtech, Simbian, Actowiz, Adsparkx:** recognized boards, but zero fresh accepted India jobs. Search snippets describing jobs as days old were not used as freshness evidence when the live source date differed.
- **NPCI, Kanerika, Spektra:** current embedded-list records lack usable country/full-description evidence for validation. Kanerika's embedded list contains titles/country but no descriptions or dates; Spektra remote entries omit country. The existing reader was not weakened to infer India or treat excerpts as complete descriptions.

`ranking.json` also records a lightweight fresh-India public API ranking for 17 additional SmartRecruiters board hypotheses. Entain, IFS, and Hitachi Solutions proceeded to full preflight. The others returned zero for that country/date query; that does not prove the employers have no jobs or that those old boards remain their current ATS. No global count is used as India supply.

## India-wide job boards

- [Cutshort terms](https://cutshort.io/terms) explicitly restrict systematic automated collection and distinguish separately approved API/MCP hiring access. No scraping connector activated; no account or partner access assumed.
- [Foundit terms](https://www.foundit.in/info/terms-of-use), particularly user obligations11 and IP provisions, require authorization for redistribution and limit general content use. No unrestricted job-feed permission verified; zero claimed supply.
- [Hirist terms](https://www.hirist.tech/terms) restrict downloading/distribution and commercial derivative use without authorization, and expressly prohibit circumventing its crawler controls. Public job browsing exists, but no authorized redistribution feed was verified.
- [Instahyre public search](https://www.instahyre.com/search-jobs/) again returned HTTP520 through the web reader. No challenge bypass, login, or source activation.
- **Talent500 held:** anonymous public search works and returned 20 sample rows with a provider total 7,086, but its actual [terms page](https://talent500.com/terms-of-use/) prohibits crawling/scraping and automated access without express written consent. The initially readable robots file is not sufficient authorization. No further bulk requests or connector implementation after confirming the terms. The official page routes TermsOfUse through `DefaultLayout` to module 79294 in `legal-FAQ.d6011651989a55402aa8.js`; both assets are saved locally. The 20-row sample is not a fresh India census. `talent500-held.json` preserves the contract for a future authorized integration: the public detail frontend uses **open_date** for schema.org **datePosted**, not creation time; external jobs expose primary redirect URLs and external requisition codes, and search supports `search_after` pagination. No synthetic job-count gain is claimed.

## Reproduction boundary

All research network reads ran through local Docker or primary-source web research. Containers received only an evidence-directory mount, no database credentials, application profiles, or application-submission capability. Vercel was untouched.
