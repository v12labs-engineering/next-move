# Professional job boards for India

Checked 17 November 2026 against the [India job portal directory](2026-11-17-india-job-portal-directory.md) and operator pages. The shortlist covers professional roles based in India and remote roles whose location terms include India or worldwide. Board counts are the counts displayed by the sites at the time of the check.

## Documented public feeds

| Board | India coverage and listing page | Feed and access |
| --- | --- | --- |
| Himalayas | [Remote jobs in India](https://himalayas.app/jobs/countries/india) | [JSON search for India](https://himalayas.app/jobs/api/search?country=IN). Includes worldwide results by default. A free key raises the rate limit. Display Himalayas credit and use its returned `applicationLink`. Onward syndication is restricted. [API reference](https://himalayas.app/docs/remote-jobs-api) |
| Jobicy | [Remote listings](https://jobicy.com/jobs) with a geographic eligibility field | [JSON API](https://jobicy.com/api/jobs) and [RSS](https://jobicy.com/jobs/feed). Public API provides seven days of listings via cursor, delayed three hours. The listing URL leads to Jobicy. Attribution and removal of expired jobs from active results are required. The original application URL is a separate paid API feature. [Feed documentation](https://jobicy.com/jobs-rss-feed) |
| Remote OK | [Global remote jobs](https://remoteok.com/remote-jobs). Confirm eligibility per role. | [Public JSON](https://remoteok.com/api) and [RSS](https://remoteok.com/remote-jobs.rss). No key. The operator asks aggregators to credit Remote OK and link to the original Remote OK listing. [Feed FAQ](https://remoteok.com/faq#feeds) |
| We Work Remotely | [Global remote board](https://weworkremotely.com/remote-jobs), including worldwide jobs | [Public RSS](https://weworkremotely.com/remote-jobs.rss), explicitly available with attributable links back to WWR. Its separate API requires a token. [RSS reuse guidance](https://weworkremotely.com/remote-job-rss-feed) · [API](https://weworkremotely.com/api) |
| Remote Gig | [Jobs open to India](https://remotegig.in/remote-jobs/open-to-india) | [Atom feed](https://remotegig.in/feed.xml), documented for feed readers and limited to the 50 newest entries. It aggregates several boards already listed here. The operator says country eligibility can be inferred, so verify on the original listing. [Feed details](https://remotegig.in/alerts) · [Source and eligibility notes](https://remotegig.in/about) |
| Hasjob | [Indian technology board](https://hasjob.co/) | [Public Atom](https://hasjob.co/feed). The feed endpoint returned an Atom response type on check. The operator's published terms are for its listing service. [Terms](https://hasjob.co/tos) |
| FzlOps | [Indian DevOps, cloud, software and data roles](https://www.fzlops.online/) | [RSS advertised by the board](https://www.fzlops.online/rss.xml). The [terms page](https://www.fzlops.online/terms/) was unavailable on recheck. Bulk reuse terms remain unverified. |
| Remotive | [India-eligible remote jobs](https://remotive.com/remote-jobs/l-india) | [Public JSON](https://remotive.com/api/remote-jobs) is delayed 24 hours and requires credit and linkback. Public API terms restrict showing listings behind signup or email collection and restrict onward syndication. Paid private API is offered. [API terms](https://remotive.com/remote-jobs/api) |

## Publisher and subscription routes

| Board | Listing page | Access |
| --- | --- | --- |
| Jooble India | [India search](https://in.jooble.org/) | [India API registration](https://in.jooble.org/api/about) issues a country-specific key. The documented free allowance is 100 requests per day per country key. [REST docs](https://help.jooble.org/en/support/solutions/articles/60001448238) · [Regional access docs](https://help.jooble.org/en/support/solutions/articles/60000922689-how-to-connect-to-the-jooble-rest-api) |
| Talent.com India | [India search](https://in.talent.com/) | Publisher program offers a search API and XML feeds. Access and India inventory depend on the account and product. [Publisher program](https://employers.talent.com/publishers) |
| Careerjet India | [India search](https://www.careerjet.co.in/) | Public site presented a verification challenge. Publisher search API uses Basic authentication with a unique site key at `https://search.api.careerjet.net/v4/query`. [Publisher API docs](https://www.careerjet.com/partners/api/) |
| Adzuna India | [India site](https://www.adzuna.in/) | Site returned HTTP 405 in the directory check. Official API lists the `in` country code at `/v1/api/jobs/in/search/{page}` and requires app credentials. Ongoing commercial reuse needs a licence. [OpenAPI specification](https://developer.adzuna.com/swagger/spec/test2.json) · [API terms](https://developer.adzuna.com/docs/terms_of_service) |
| Remote Rocketship | [India-eligible jobs](https://www.remoterocketship.com/country/india/) | Public previews. Live API searches require a subscription and bearer key. The unkeyed sandbox returns a fictional example. [Developer portal](https://www.remoterocketship.com/developers/) |

## Broad boards with professional inventory

| Board | Listing page | Access |
| --- | --- | --- |
| Naukri | [India jobs](https://www.naukri.com/jobs-in-india) | Automated listing check blocked by robots. Naukri publishes employer and recruiter posting integrations, while access to an outbound listing feed remains unverified. [Recruiter posting](https://recruit.naukri.com/hiringsuite/naukri-jobposting.html) |
| LinkedIn Jobs | [India jobs](https://in.linkedin.com/jobs/jobs-in-india) | Public search preview and account features. Operator prohibits scraping and automated activity. The documented Job Posting API is for approved partners publishing to LinkedIn. [Operator guidance](https://www.linkedin.com/help/recruiter/answer/a1341387) · [Job Posting API](https://learn.microsoft.com/en-us/linkedin/talent/job-postings/api/overview) |
| Indeed India | [India jobs](https://in.indeed.com/l-india-jobs.html) | Public listings. Automated access needs express permission or an allowance under the applicable robots rules. Job Sync is an approved publisher integration. [Terms](https://www.indeed.com/legal) · [Job Sync](https://docs.indeed.com/job-sync-api/integrate-with-job-sync-api) |
| foundit | [Software engineer listings](https://www.foundit.in/search/software-engineer-jobs) | Public role search displayed more than 30,000 results and included named India employers. Its terms restrict copying or transmission of the service. [Terms](https://www.foundit.in/info/terms-of-use) |
| Shine | [India jobs](https://www.shine.com/job-search/jobs-in-india) | Public search. Terms condition automated access on robots rules or prior consent. Robots excludes `/api/` and specific search paths. [Terms](https://www.shine.com/termsandconditions) · [Robots](https://www.shine.com/robots.txt) |
| Glassdoor India | [India jobs](https://www.glassdoor.co.in/Job/india-jobs-SRCH_IL.0,5_IN115.htm) | Public listing previews. Check each location since the country page also showed some overseas roles. |
| PlacementIndia | [Professional search example](https://www.placementindia.com/job-search/software-engineer-jobs.htm) | Public search. Terms limit redistribution of proprietary information. [Terms](https://www.placementindia.com/terms-seeker.htm) |
| JobRinger | [India job search](https://jobringer.com/) | Public search entry. [Terms](https://www.jobringer.com/terms%26condition) |
| National Career Service | [Domestic search](https://ncs.gov.in/job-listing) | Public search interface with dynamically loaded results. Nationwide public and private jobs. |
| MyJobb | [Job browse](https://myjobb.ai/jobs/browse) | Public previews across industries. Its terms prohibit using the service to scrape, harvest or resell job data. [Terms](https://myjobb.ai/terms-of-service) |

## Technology, product, management and diversity hiring

| Board | Listing page | Access |
| --- | --- | --- |
| Cutshort | [India job categories](https://cutshort.io/jobs) | Public categories. Its terms restrict automated access and provide separate programmatic access for eligible hiring customers. [Terms](https://cutshort.io/terms) |
| Instahyre | [Candidate search](https://www.instahyre.com/search-jobs/) | Candidate matching platform. Direct list check returned HTTP 520. [Candidate help](https://help.instahyre.com/en/article/what-is-instahyre-1ufln5/) |
| hirist | [Technology board](https://www.hirist.tech/) | Public categories. Terms restrict reuse and prohibit circumventing automation controls. [Terms](https://www.hirist.tech/terms) |
| iimjobs | [Management and finance categories](https://www.iimjobs.com/) | Public categories. Terms limit downloading or republication without authorization and prohibit circumventing automation controls. [Terms](https://www.iimjobs.com/terms) |
| Wellfound | [India startup jobs](https://wellfound.com/location/india) | Public listings and candidate account. Terms restrict harvesting, copying and commercial reuse. [Terms](https://wellfound.com/terms) |
| Y Combinator Startup Jobs | [India startup jobs](https://www.ycombinator.com/jobs/location/india) | Public listings and candidate profile. YC's terms restrict scraping, data mining and commercial reuse without authorization. [Terms](https://www.ycombinator.com/legal) |
| The Product Folks | [Product management board](https://www.theproductfolks.com/product-management-jobs) | Public curated board. [Terms](https://www.theproductfolks.com/terms-and-conditions) |
| Shipmates | [India product management jobs](https://heyshipmates.com/jobs?country=in) | Public filtered listings. The page displayed 289 openings. Some dates are first-added dates. |
| Uplers | [Talent platform](https://www.uplers.com/talent/) | Candidate registration, with some individual listings readable publicly. [India listing example](https://platform.uplers.com/talent/all-opportunities/HR1178957742095511) |
| TopHire | [Candidate marketplace](https://tophire.co/) | Candidate profile and matching flow. Public listing export unverified. |
| HerKey | [Professional job search](https://www.herkey.com/jobs) | Public search for women and career returners, with account features. |
| myAvtar | [Featured professional jobs](https://www.myavtar.com/featuredjobs) | Public featured listings for diversity hiring. |

## Remote and staffing boards with website listings

| Board | Listing page | Access |
| --- | --- | --- |
| Working Nomads | [Remote jobs in India](https://www.workingnomads.com/remote-india-jobs) | Public entry. Results need rendering. |
| Arc | [Remote India jobs](https://arc.dev/remote-jobs/india) | Public India search with technology and other professional roles. |
| Jobgether | [Remote jobs in India](https://jobgether.com/remote-jobs/india) | Public listing search. |
| FlexJobs | [India listings](https://www.flexjobs.com/remote-jobs/world/india) | Public previews and paid member access. |
| Randstad India | [India vacancies](https://www.randstad.in/jobs/) | Public staffing search displayed 1,050 results across several professions, with recent posts. |
| Michael Page India | [India professional jobs](https://www.michaelpage.co.in/jobs) | Public search displayed roughly 1,950 India jobs. Site terms limit material to personal or noncommercial use. [Terms](https://www.michaelpage.co.in/terms-and-conditions) |
| Adecco India | [India job search entry](https://www.adecco.com/en-in) | Public staffing portal. Search results require checking the portal's job search flow. |
| TeamLease Jobs | [Staffing jobs](https://www.teamlease.com/teamlease-jobs) | Indexed multi-employer route. Direct automated check returned HTTP 403. |
| JAC Recruitment India | [Professional staffing jobs](https://www.jac-recruitment.in/jobs) | Direct automated check returned HTTP 403. |
| e2eHiring | [Public job search](https://www.e2ehiring.com/jobs) | The `www` route showed listings and detail links. The bare host also showed a client-rendered shell. [Terms](https://e2ehiring.com/terms-and-conditions) |

## Regional and specialist sources

| Board | Profession or region | Listing page and access |
| --- | --- | --- |
| Infopark | Technology park tenant companies across Kerala | [All-campus jobs](https://infopark.in/companies-job). Public postings, tenant names and deadlines. |
| Technopark | Thiruvananthapuram technology park employers | [Job search](https://technopark.in/job-search?lang=e). Public listings and detail pages. |
| Cyberpark Kozhikode | Technology park tenant jobs in Kozhikode | [Careers](https://cyberparks.in/careers/). Public search. Listing cards require JavaScript. |
| UL CyberPark | IT employers in Kozhikode | [Tenant jobs](https://www.ulcyberpark.com/jobs). Public listings and deadlines. |
| eFinancialCareers | Banking, finance and professional services | [India jobs](https://www.efinancialcareers.com/jobs/finance/in-india?countryCode=IN&location=India). Public country search and account options. |
| CAclubindia Jobs | CA, CS, CMA, tax and accounting | [Professional jobs](https://www.caclubindia.com/jobs/). Public search also includes articleships. |
| Bar & Bench | Legal practice and research | [Legal jobs](https://www.barandbench.com/legal-jobs). Public vacancy articles. |
| Lawctopus | Legal practice, teaching and public sector | [Legal jobs](https://www.lawctopus.com/category/opportunities-events/jobs/). Public vacancy articles. |
| IndiaBioscience | Research, faculty, lab and life sciences | [Jobs](https://indiabioscience.org/jobs). Public listings. |
| PharmaTutor | Pharmaceutical, pharmacy and research | [Vacancies](https://www.pharmatutor.org/pharma-jobs/vacancies.html). Public vacancy articles. |
| FacultyPlus | School and university teaching | [Teaching jobs](https://www.facultyplus.com/category/teaching-jobs/). Public notices. |
| DevNetJobsIndia | Indian NGOs, CSR and development | [Latest jobs](https://www.devnetjobsindia.org/standard_jobs.aspx). Public index. Selected details require membership. |
| Impactpool | International and development organisations in India | [India vacancies](https://www.impactpool.org/countries/India). Public listings. |
| ConstructionPlacements | Engineering, construction and infrastructure | [Engineering vacancies](https://www.constructionplacements.com/government-engineering-jobs/). Public curated notice index. |
| Energy Jobline | Energy sector engineering | [India jobs](https://www.energyjobline.com/jobs/india-0). Public country search. |
| Aviation Job Search | Aviation professionals | [India jobs](https://www.aviationjobsearch.com/en-GB/jobs-in-india). Public country search. |
| FashionJobs India | Fashion, luxury and retail professionals | [India jobs](https://in.fashionjobs.com/s/). Public listings. |
| Hozpitality | Hotel and hospitality professionals | [Job search](https://www.hozpitality.com/jobs). Public search entry. [India listing example](https://www.hozpitality.com/jobs/details/assistant-food-beverage-manager-marriott-international-food-beverage-manager-india-mumbai-jobId198547) |
| Atypical Advantage | Professional jobs for people with disabilities | [Find jobs](https://atypicaladvantage.in/find-a-job). Public listings and filters. |

## Initial collection results

The local Postgres run finished at 2026-11-17 07:29:45 IST. Run ID `41a21e6a-771a-482a-8754-1a143aea6a21`.

The first pass saved **438 postings from 16 boards**. 384 included India in the location or eligibility data and 54 were tagged worldwide remote. Counts use the saved posting identities. Syndicated listings may appear on more than one board.

The monitored catalogue held 557 active India jobs from 55 direct employer feeds and 44 from Infopark. The portal run and the monitored catalogue share 44 exact Infopark listing URLs.

The run recorded 87 boards. Partial results reflect limited feed windows, pagination, role scope or blocked detail pages. The Himalayas request used `exclude_worldwide=true` to prioritise India eligibility. Four boards required a candidate account. The browser checked 12 boards. Six challenges remained, and the 2Captcha image-grid integration submitted zero solve tasks.

| Board | Outcome | Saved postings | Evidence or coverage note |
| --- | --- | ---: | --- |
| [Himalayas](https://himalayas.app/jobs/countries/india) | Partial | 199 | Public feed has more pages after the first pass |
| [Shipmates](https://heyshipmates.com/jobs?country=in) | Partial | 63 | Some individual postings still need verification |
| [Infopark](https://infopark.in/companies-job) | Partial | 44 | Infopark reader covers recent software roles |
| [We Work Remotely](https://weworkremotely.com/remote-jobs) | Partial | 32 | Latest published feed window |
| [SimplyHired India](https://www.simplyhired.co.in/search?l=india&q=software+engineer) | Collected | 20 | — |
| [TeamLease Jobs](https://www.teamlease.com/teamlease-jobs) | Collected | 19 | — |
| [Jobicy](https://jobicy.com/jobs) | Partial | 14 | Public feed has more pages after the first pass |
| [Teachers Recruiter](https://www.teachersrecruiter.in/jobs) | Collected | 10 | — |
| [e2eHiring](https://www.e2ehiring.com/jobs) | Collected | 9 | — |
| [Rigzone](https://www.rigzone.com/oil/jobs/recent/) | Partial | 8 | robots.txt excludes a requested page |
| [Remote Rocketship](https://www.remoterocketship.com/country/india/) | Partial | 5 | Some individual postings still need verification |
| [Remotive](https://remotive.com/remote-jobs/l-india) | Partial | 5 | Publisher's recent feed window |
| [Remote OK](https://remoteok.com/remote-jobs) | Partial | 4 | Publisher's recent feed window |
| [Energy Jobline](https://www.energyjobline.com/jobs/india-0) | Partial | 3 | robots.txt excludes a requested page |
| [Remote.co](https://remote.co/remote-jobs) | Collected | 2 | — |
| [Hasjob](https://hasjob.co/) | Partial | 1 | Latest published feed window |
| [Academic Jobs](https://www.academicjobs.com/en-in/jobs) | No verified matches | 0 | — |
| [Adecco India](https://www.adecco.com/en-in) | No verified matches | 0 | — |
| [Adzuna India](https://www.adzuna.in/) | No verified matches | 0 | — |
| [Arc](https://arc.dev/remote-jobs/india) | Zero eligible in feed | 0 | — |
| [Atypical Advantage](https://atypicaladvantage.in/find-a-job) | No verified matches | 0 | — |
| [Aviation Job Search](https://www.aviationjobsearch.com/en-GB/jobs-in-india) | Unavailable | 0 | Invalid redirect |
| [Bar & Bench](https://www.barandbench.com/legal-jobs) | No verified matches | 0 | — |
| [beBee India](https://in.bebee.com/jobs) | Unavailable | 0 | Redirect left the evidenced employer or ATS |
| [BioTecNika](https://www.biotecnika.org/category/jobs/) | Restricted | 0 | HTTP 403 |
| [CAclubindia Jobs](https://www.caclubindia.com/jobs/) | Partial | 0 | Employer requires sign-in |
| [Careerjet India](https://www.careerjet.co.in/) | No verified matches | 0 | — |
| [Chayan](https://getchayan.com/) | Restricted | 0 | [Operator terms](https://getchayan.com/terms) |
| [ConstructionPlacements](https://www.constructionplacements.com/government-engineering-jobs/) | Restricted | 0 | HTTP 403 |
| [Cutshort](https://cutshort.io/jobs) | Restricted | 0 | [Operator terms](https://cutshort.io/terms) |
| [Cyberpark Kozhikode](https://cyberparks.in/careers/) | No verified matches | 0 | — |
| [DevNetJobsIndia](https://www.devnetjobsindia.org/standard_jobs.aspx) | Partial | 0 | Some individual postings still need verification |
| [Doctor Jobs India](https://www.doctorjobsindia.com/) | No verified matches | 0 | — |
| [eFinancialCareers](https://www.efinancialcareers.com/jobs/finance/in-india?countryCode=IN&currencyCode=USD&includeUnspecifiedSalary=true&language=en&latitude=20.59368&location=India&locationPrecision=Country&longitude=78.96288&pageSize=15&q=finance&radius=50&radiusUnit=mi) | Unavailable | 0 | HTTP 405 |
| [Expertini India](https://in.expertini.com/) | Challenge | 0 | Public challenge did not clear |
| [Faculty Hub](https://facultyhub.in/jobs) | Partial | 0 | HTTP 500 |
| [FacultyPlus](https://www.facultyplus.com/category/teaching-jobs/) | Partial | 0 | Listing pagination was incomplete |
| [FashionJobs India](https://in.fashionjobs.com/s/) | Restricted | 0 | HTTP 403 |
| [FlexiBees](https://www.flexibees.com/) | Skipped sign-in | 0 | Candidate account required to browse matches |
| [FlexJobs](https://www.flexjobs.com/remote-jobs/world/india) | Skipped sign-in | 0 | Candidate account required to browse matches |
| [foundit](https://www.foundit.in/search/software-engineer-jobs) | Restricted | 0 | [Operator terms](https://www.foundit.in/info/terms-of-use) |
| [FzlOps](https://www.fzlops.online/) | Partial | 0 | Latest published feed window |
| [Glassdoor India](https://www.glassdoor.co.in/Job/india-jobs-SRCH_IL.0,5_IN115.htm) | Challenge | 0 | Public challenge did not clear |
| [GrabJobs India](https://grabjobs.co/india) | Challenge | 0 | Public challenge did not clear |
| [HerKey](https://www.herkey.com/jobs) | No verified matches | 0 | — |
| [hirist](https://www.hirist.tech/) | Restricted | 0 | [Operator terms](https://www.hirist.tech/terms) |
| [Hozpitality](https://www.hozpitality.com/jobs) | No verified matches | 0 | — |
| [iimjobs](https://www.iimjobs.com/) | Restricted | 0 | [Operator terms](https://www.iimjobs.com/terms) |
| [Impactpool](https://www.impactpool.org/countries/India) | Partial | 0 | Cloudflare challenge |
| [Indeed India](https://in.indeed.com/l-india-jobs.html) | Restricted | 0 | HTTP 403 |
| [IndiaBioscience](https://indiabioscience.org/jobs) | Challenge | 0 | Public challenge did not clear |
| [Instahyre](https://www.instahyre.com/search-jobs/) | Challenge | 0 | Public challenge did not clear |
| [JAC Recruitment India](https://www.jac-recruitment.in/jobs) | No verified matches | 0 | — |
| [Jobgether](https://jobgether.com/remote-jobs/india) | Restricted | 0 | HTTP 403 |
| [JobRinger](https://jobringer.com/) | No verified matches | 0 | — |
| [Jobslooker India](https://in.jobslooker.com/) | No verified matches | 0 | — |
| [Jobsora India](https://in.jobsora.com/) | No verified matches | 0 | — |
| [Jooble India](https://in.jooble.org/) | Challenge | 0 | Public challenge did not clear |
| [Lawctopus](https://www.lawctopus.com/category/opportunities-events/jobs/) | Restricted | 0 | robots.txt excludes a requested page |
| [LinkedIn Jobs](https://in.linkedin.com/jobs/jobs-in-india) | Restricted | 0 | [Operator terms](https://www.linkedin.com/legal/user-agreement) |
| [LiveLaw](https://www.livelaw.in/job-updates) | Partial | 0 | Listing pagination was incomplete |
| [Michael Page India](https://www.michaelpage.co.in/jobs) | Restricted | 0 | [Operator terms](https://www.michaelpage.co.in/terms-and-conditions) |
| [myAvtar](https://www.myavtar.com/featuredjobs) | Unavailable | 0 | fetch failed |
| [MyJobb](https://myjobb.ai/jobs/browse) | Restricted | 0 | [Operator terms](https://myjobb.ai/terms-of-service) |
| [National Career Service (NCS)](https://ncs.gov.in/job-listing) | No verified matches | 0 | — |
| [Naukri](https://www.naukri.com/jobs-in-india) | Restricted | 0 | HTTP 403 |
| [NGOBOX](https://ngobox.org/job_listing.php) | No verified matches | 0 | — |
| [PharmaTutor](https://www.pharmatutor.org/pharma-jobs/vacancies.html) | Partial | 0 | Cloudflare challenge |
| [PlacementIndia](https://www.placementindia.com/job-search/) | No verified matches | 0 | — |
| [Randstad India](https://www.randstad.in/jobs/) | Partial | 0 | Some individual postings still need verification |
| [Remote Gig](https://remotegig.in/remote-jobs/open-to-india) | Partial | 0 | Latest published feed window |
| [Rozgar.com](https://rozgar.com/) | No verified matches | 0 | — |
| [Seajob](https://www.seajob.net/) | No verified matches | 0 | — |
| [Shine](https://www.shine.com/job-search/fullstack-software-developer-jobs) | Partial | 0 | Listing pagination was incomplete |
| [Talent.com India](https://in.talent.com/) | No verified matches | 0 | — |
| [Technopark](https://technopark.in/job-search?lang=e) | No verified matches | 0 | — |
| [The Product Folks](https://www.theproductfolks.com/product-management-jobs) | Partial | 0 | Listing pagination was incomplete |
| [TimesJobs](https://m.timesjobs.com/mobile/jobs-search-result.html?cboWorkExp1=0) | Unavailable | 0 | Redirect left the evidenced employer or ATS |
| [TopHire](https://tophire.co/) | Skipped sign-in | 0 | Candidate account required to browse matches |
| [Trabajo.org India](https://in.trabajo.org/) | No verified matches | 0 | — |
| [UL CyberPark](https://www.ulcyberpark.com/jobs) | No verified matches | 0 | — |
| [UNjobs](https://unjobs.org/duty_stations/india) | Restricted | 0 | robots.txt excludes a requested page |
| [Uplers](https://www.uplers.com/talent/) | Skipped sign-in | 0 | Candidate account required to browse matches |
| [Wellfound](https://wellfound.com/location/india) | Restricted | 0 | [Operator terms](https://wellfound.com/terms) |
| [WhatJobs India](https://en-in.whatjobs.com/jobs) | No verified matches | 0 | — |
| [Working Nomads](https://www.workingnomads.com/remote-india-jobs) | No verified matches | 0 | — |
| [Y Combinator Startup Jobs](https://www.ycombinator.com/jobs/location/india) | Restricted | 0 | [Operator terms](https://www.ycombinator.com/legal) |

## CAPTCHA retry and deduplication

The follow-up checked eight previously challenged sources. Instahyre returned a public page with zero verifiable postings. Expertini India and IndiaBioscience returned Cloudflare blocks before a solver-ready widget appeared. The production 2Captcha credential passed validation, and the retry submitted zero paid solve requests and saved zero new postings. [Turnstile task requirements](https://2captcha.com/api-docs/cloudflare-turnstile)

Five sources have published collection restrictions. [Glassdoor](https://www.glassdoor.co.in/about/terms/), [GrabJobs](https://grabjobs.co/resources/about-us/terms-of-use/), [Jooble](https://in.jooble.org/info/terms), [Impactpool](https://www.impactpool.org/signup/terms), [PharmaTutor](https://www.pharmatutor.org/terms-of-use)

The local deduplicated snapshot was saved at 2026-11-17 09:00:05 IST in `india_employer_registry.registry_india_deduped_job`.

| Source | Saved rows | Distinct openings |
| --- | ---: | ---: |
| Job portals | 438 | 437 |
| Monitored catalogue | 602 | 585 |
| Combined | 1040 | 978 |

The combined count accounts for 44 Infopark listings shared by both sources, 17 repeated city rows for the same requisitions, and 1 syndicated Teach For All listing. The snapshot preserves all 1040 source observations and the locations for all 5 multi-city openings.

Matches use the canonical application link or an ATS requisition ID. The syndicated listing matched by employer, title, posting dates, and near-identical descriptions.

```sh
node --import tsx scripts/india/dedupe-india-job-postings.mts \
  --project job-search-drill-9sbub4-restored --run 41a21e6a-771a-482a-8754-1a143aea6a21
```
