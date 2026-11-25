# Additional India ATS sources: complete public-feed verification

Research date: 17 November 2026. This pass investigated **37 distinct, previously
inactive sources** using official employer/provider pages and full connector
previews in isolated local Docker containers. It found **12 ready sources with
91 distinct fresh India posting URLs**. These are measured available postings,
**not jobs added to the database**. No database writes, source activations,
applications, or Vercel operations were performed by this research.

The inventory comparison uses the frozen directory/candidate export at
`.local-data/rollouts/2026-11-17-india-expansion-2/source-inventory.json`.
Freshness means an employer/provider-stated date inside the existing 30-day
window, not a date fabricated from collection time. Every ready source completed
the existing strict reader with `nextPage:null`; counts are deduplicated by
canonical posting URL and restricted to India and supported job categories.
Live request outcomes, validation evidence, full posting descriptions and exact
activation inputs are under the sibling `boards/` directory.

## Ready handoff

All sources below use `config:{}` and `countries:["India"]`. For Keka, the board
is the portion after `keka:`; for Zoho, it is the complete hostname after
`zohorecruit:`. Company values are the provider's verified organization identity,
as preserved in `boards/ready-final.json`. Ready counts are the full measured
inventories after eligibility/freshness filtering, not search-engine estimates.

| Exact source ID | Verified company | Fresh India URLs | Official listing |
| --- | --- | ---: | --- |
| `keka:techdome` | Techdome | 20 | [Careers](https://techdome.keka.com/careers/) |
| `keka:gokwik` | GoKwik Commerce Solutions Pvt. Ltd. | 13 | [Careers](https://gokwik.keka.com/careers/) |
| `keka:evolve` | Zenskar | 2 | [Careers](https://evolve.keka.com/careers/) |
| `keka:tvsnext` | TVS NEXT | 2 | [Careers](https://tvsnext.keka.com/careers/) |
| `zohorecruit:staples.zohorecruit.in` | Staples India Business Innovation Hub Private Limited | 10 | [Careers](https://staples.zohorecruit.in/jobs/Careers) |
| `zohorecruit:genworx.zohorecruit.com` | Genworx.Ai Technology Solutions Private Limited | 2 | [Careers](https://genworx.zohorecruit.com/jobs/Careers) |
| `zohorecruit:agivant.zohorecruit.in` | Agivant Technologies India Private Limited | 9 | [Careers](https://agivant.zohorecruit.in/jobs/Careers) |
| `zohorecruit:connexr.zohorecruit.in` | ConnexR Solutions | 19 | [Careers](https://connexr.zohorecruit.in/jobs/Careers) |
| `keka:ihl` | India Health Link Pvt Ltd | 4 | [Careers](https://ihl.keka.com/careers/) |
| `keka:codewinglet` | codewinglet | 5 | [Careers](https://codewinglet.keka.com/careers/) |
| `keka:popclub` | Poptech Growth Private Limited | 1 | [Careers](https://popclub.keka.com/careers/) |
| `keka:inxiteout` | Inxite-out | 4 | [Careers](https://inxiteout.keka.com/careers/) |

ConnexR is a staffing/technology-services source publishing technical client
roles. Attribution must remain **ConnexR Solutions**; this research does not
claim that each client role is direct employment at ConnexR. The one fresh POP
posting is explicitly a **software QA internship**. Separate requisition IDs with
similar titles remain separate records; no title-only merging was used.
[ConnexR public postings](https://connexr.zohorecruit.in/jobs/Careers),
[POP public active inventory](https://popclub.keka.com/careers/api/jobs/default/active).

## Keka default-portal gap: verified and repaired

The original Keka reader required a GUID embedded in a custom portal's
`/ats/documents/<guid>/careerportal/...html` URL. Six official ordinary career
pages lacked that custom-page marker and therefore failed with a schema/identity
review result. Their ordinary page instead contains `base#baseHref` with
`/careers/`, an empty `meta[name=portalName]`, `#kh-jobs-section`, and Keka's
official public frontend script. These are different presentations of public
career listings, not authentication failures.
[POP default portal](https://popclub.keka.com/careers/),
[Techdome custom portal](https://techdome.keka.com/careers/).

The observed official frontend rewrites `/api/...` through the page's base path
and calls `GET /careers/api/jobs/default/active`. It receives the complete active
job array, including descriptions, then groups and filters that array in the
browser. `GET /careers/api/organization/default/careerportalinfo` supplies the
employer identity and `careersPortalDomain`. Live verification returned all nine
POP records and all thirteen Inxite-out records before category/freshness
filtering. No pagination token or per-page API is used by this frontend.
[Official Keka frontend](https://cdn.keka.com/careers/v/2026/scripts/app/app.min.js),
[POP identity](https://popclub.keka.com/careers/api/organization/default/careerportalinfo),
[POP active jobs](https://popclub.keka.com/careers/api/jobs/default/active),
[Inxite-out active jobs](https://inxiteout.keka.com/careers/api/jobs/default/active).

The change in `lib/server/catalog/connectors/keka.ts` keeps the existing GUID
reader intact. It enables the default endpoint only after all four default-page
markers match and requires the returned employer domain to match the selected
board. Both paths reject duplicate job identifiers and retain the existing
5,000-record array/schema bound. A paginated wrapper, malformed response,
employer mismatch, provider refusal or incomplete page does not become an empty
successful inventory. No alternative endpoint is attempted after a provider
refusal.

After the change, all six previously unsupported default portals completed live
Docker previews. IHL, Codewinglet, POP and Inxite-out contributed fourteen fresh
eligible India URLs. Neuroniks and Actowiz had zero in this window and are not
recommended for activation merely to increase the source count.
[IHL](https://ihl.keka.com/careers/),
[Codewinglet](https://codewinglet.keka.com/careers/),
[Neuroniks](https://neuroniks.keka.com/careers/),
[Actowiz](https://actowiz.keka.com/careers/).

Five new tests cover full default inventory beyond 100 records, organization
identity mismatch, incomplete/default-versus-named portal evidence, duplicate
IDs/paginated wrappers, and provider refusals. Existing custom-portal connector,
discovery-lifecycle and durable-worker tests passed unchanged. Focused ESLint,
full TypeScript checking and diff checks passed. The tests do not substitute for
the saved live full-inventory previews.

## High counts that are not ready supply

**2COMS:** The current reader accepted 110 fresh India URLs, but inspection found
India-labelled records whose full description explicitly places an HVAC Sales
Engineer in **Kuwait**. Many other records are FMCG, retail, chemicals, insurance
and field-sales jobs rather than software-adjacent positions. Keep this source
held until a general, tested geography/scope rule resolves these cases. Do not
publish it and then remove a few manually selected IDs.
[Official 2COMS inventory](https://2coms.zohorecruit.in/jobs/Careers).

**CLIQHR:** Ten fresh India URLs passed the mechanical reader. Full descriptions
include retail gold/food/toys sales and industrial rubber-chemical sales, mixed
with valid software and IT-sales vacancies. It is a staffing agency and must be
labelled as such. The source is held from the reviewed software-adjacent cohort;
the raw count of ten is not presented as clean incremental supply.
[Official CLIQHR inventory](https://cliqhr.zohorecruit.in/jobs/Careers).

**Training Basket / Jobbasket:** Forty fresh India URLs passed the reader. The
site explicitly describes at least some openings as sourced from public job
boards and empanelled employers/recruiters. Their underlying employers and
cross-board requisition identities were not established here. Keep this separate
from the ready direct-employer/identified-agency cohort rather than claiming forty
additional underlying vacancies.
[Official inventory](https://trainingbasket.zohorecruit.com/jobs/Careers),
[example source disclaimer](https://trainingbasket.zohorecruit.com/jobs/Careers/460790000044515440/Full-Stack-Developer).

## Remaining imported candidates and unsupported inventories

Fresh live checks of Delta Capita, cbs APAC, dss+, GSB Solutions, Metyis,
Paralucent, 73 Strings, TLC Worldwide and David Kennedy Recruitment produced
**zero fresh eligible India postings**. Some had India jobs outside the freshness
window; others had India evidence only in roles outside the configured category
scope. Their previous `accepted_count` values represented broad/global
inventories and must not be interpreted as fresh India supply. David Kennedy's
full preview completed two pages; the other completed imported previews used
one page. Fortray's full reader refused an eligible posting lacking country
evidence, so its inventory is incomplete and held.
[Delta Capita](https://careersdeltacapita.recruitee.com/),
[Metyis](https://metyisag.recruitee.com/),
[GSB Solutions](https://gsbsolutions1.recruitee.com/),
[Fortray](https://fortrayglobalservices.teamtailor.com/),
[David Kennedy Recruitment](https://davidkennedyrecruitment.teamtailor.com/).

Personio AMINA's XML endpoint returned HTTP 404 despite its public HTML career
page showing roles. This pass did not infer an XML inventory from HTML search
results. AVOW lacked usable country/description evidence; TradeTracker's full
reader rejected an incomplete description. CloudNow, Indovance and CodeStore
Zoho candidates also lacked usable country/description evidence. These are
recorded holds, not counts of collectible jobs. No refused response was
circumvented. Infopark `infopark:kerala` was already enabled in the local
inventory; adding an alias of its all-campus source would not add coverage.
[AMINA careers](https://amina.jobs.personio.com/),
[AMINA XML](https://amina.jobs.personio.com/xml),
[AVOW](https://avow.jobs.personio.com/),
[TradeTracker](https://tradetracker.jobs.personio.com/),
[Infopark all-campus jobs](https://infopark.in/companies-job).

## Evidence files

Under `.local-data/rollouts/2026-11-17-india-expansion-2/boards/`:

- `ready-final.json`: exact twelve source definitions, company identities,
  configuration, URLs, counts and validation evidence for the rollout owner.
- `preflight.json`: initial thirty-source full previews.
- `review-preflight.json`: description review and seven additional sources.
- `default-preflight.json`: six live Keka default-portal previews after the fix.
- `*-fresh-details.json`: full public descriptions used for scope/geography
  review, including the two held agency inventories.
- `*-responses.json`: public feed/HTML evidence, with requested URLs.
- `keka-frontend.json`, `keka-cdn-robots.json`, `popclub-portal-info.json`,
  `popclub-active-jobs.json`, `inxiteout-active-jobs.json`: public API contract.
- `research-summary.json`: distinct sources inspected, ready counts, category
  totals and recorded provider/schema failures.

The rollout owner must still activate, collect and compare canonical URLs with
the frozen local baseline before reporting actual additional unique jobs.
