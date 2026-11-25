# Public sources for India company websites and careers

Checked 16 November 2026. The anonymous October MCA mirror contains 3,192,604 registered companies and no website or career links. The corresponding government resource reports 3,738,721 records for a separate snapshot. No source reviewed here supplied a public national CIN-to-website mapping. The strongest public sources give different pieces of evidence for a join. [India business-register research](2026-11-16-india-business-registers.md) · [MCA master-data resource](https://www.data.gov.in/resource/registrars-companies-roc-wise-company-master-data)

## Overture Bengaluru test

Overture Places exposes names, website URLs, addresses, operating status, categories, place IDs, and source metadata in public GeoParquet. The place ID identifies a location. Match the legal or observed business name and corroborate identity using location or a first-party filing. Preserve upstream source attribution from the records and the release. The Places theme includes CDLA-Permissive-2.0 data, Foursquare Apache-2.0 data with attribution, and AllThePlaces CC0 data. [Places schema](https://docs.overturemaps.org/schema/reference/places/place/) · [Release calendar](https://docs.overturemaps.org/release-calendar/) · [Attribution](https://docs.overturemaps.org/attribution/)

Downloaded the `2026-10-21.0` Bengaluru bounding box `77.45,12.82,77.76,13.12` anonymously using the official Python CLI. The test compared unique exact normalized place names with names and recorded aliases in the existing 1,449-employer directory. Normalization folded case and punctuation and stripped common legal suffixes. Indian addresses, a website field, and a location without a permanent-closure flag were required. The join did not require the place and employer geography to agree. [Python CLI](https://docs.overturemaps.org/getting-data/overturemaps-py/) · [Existing employer directory](2026-11-16-india-employer-feeds.md)

| Bengaluru test | Count |
| --- | ---: |
| Place features downloaded | 205,393 |
| Features with an India address | 205,377 |
| Exact-name point hits | 67 |
| Distinct employers matched | 48 |
| Employers whose existing website allowed comparison | 41 |
| Employers with at least one website hostname in common | 35 |
| Employers with no saved website and a lead from this join | 7 |
| Distinct legal-suffix place names with one candidate hostname in a separate export | 4,523 |

An Oracle place pointed to `iflexbpo.com`. An H&M name hit described a real estate service with a Facebook link. Some hostname disagreements may reflect rebrands, shared corporate domains or prior data errors. The sample measures candidate retrieval in one metro. Nationwide coverage and precision remain unknown.

An independent read-only join against the 3,192,604-row MCA snapshot preserved the legal suffix and ignored case and punctuation. The 4,523 single-host candidate names produced 1,529 distinct name matches across 1,541 registry rows. Requiring one registry ID and one website host retained 1,516 leads. Of these, 1,456 were active and 1,199 active leads had Karnataka on both records. Domain activity and job feeds still require verification.

Three leads were checked against first-party pages, and the corresponding active registry identities were found in the October mirror.

| Employer and CIN | Public evidence |
| --- | --- |
| Bhilwara Infotechnology Limited · `U74899DL2000PLC104401` | The employer website identifies the full legal name and lists software vacancies on a public careers page. Posting freshness is unverified. [Company](https://www.bhilwarainfo.com/aboutus.php) · [Careers](https://bhilwarainfo.com/careers.php) |
| Brady Company India Private Limited · `U72900KA2006PTC038697` | The parent company identifies the named subsidiary in Bengaluru and publishes a corporate career site. Current India job coverage is unverified. [Group locations](https://www.bradycorp.com/en-us/corporate/contact-us) · [Careers](https://www.bradycorp.com/en-us/corporate/careers) |
| Quest Global Engineering Services Private Limited · `U74900KA2014PTC076219` | The company discloses the exact CIN and both Indian office details and the corporate domain. Its public listings include software jobs in India. [Company disclosure](https://www.questglobal.com/wp-content/uploads/2025/02/QGESPL-Corporate-Information.pdf) · [Job listings](https://careers.quest-global.com/global/en/c/communications-jobs) |

### Repeat the extract locally

```sh
uv --cache-dir /tmp/job-search-overture-uv-cache tool run --from overturemaps \
  overturemaps download --bbox=77.45,12.82,77.76,13.12 -t place \
  -r 2026-10-21.0 -f geojsonseq --connect_timeout 7 --request_timeout 25 \
  -o /tmp/job-search-overture-bengaluru.geojsonseq

python3 .local-data/india-business-registers/extract-overture-websites.py \
  /tmp/job-search-overture-bengaluru.geojsonseq \
  .local-data/india-business-registers/job-search-overture-bengaluru-websites.csv \
  .local-data/india-business-registers/overture-bengaluru-legal-website-leads.csv
```

The ignored working directory `.local-data/india-business-registers/` has both CSVs, the extraction and comparison scripts, and `overture-bengaluru-website-candidates.json` for the 1,449-employer comparison. The CSV website field is the candidate HTTPS origin from the observed hostname. The CSV columns contain no phone, email, or street address fields.

The same release and extraction process applied to the Hyderabad bounding box `78.29,17.25,78.63,17.57` downloaded 153,338 places and exported 66,683 name-and-host observations. The smaller `overture-hyderabad-legal-website-leads.csv` contains 2,747 distinct legal-suffix names with one candidate host each. These counts precede registry matching and career-page checks.

## Nationwide local import

The [local registry runbook](../../deploy/local/README.md#import-and-enrich-the-india-company-registry)
uses the public STAC file index to locate the two October Places partitions
that intersect India. It exported 89,250 place-and-website observations with an
Indian address region and a legal company suffix. The local join added 24,151
website candidates for active registrations across 27 states and union
territories, in addition to the two metro imports. The check requires a unique
registry name in the same state and a single matching host. Each candidate
retains its registry ID, release, and Overture Place ID for review. [STAC catalog](https://docs.overturemaps.org/getting-data/cloud-sources/)

After the first verification run, local Postgres had website candidates for
27,599 registrations. It confirmed reachable websites for 1,302 companies
and reached 703 distinct employer careers URLs attached to 602 companies.
Website checks found 323 registration-and-careers links that passed public
access checks. There were 23,551 website candidates awaiting a first check
and 222 deferred after a temporary failure. The career counts measure page
access. Vacancy coverage and freshness require a separate job-feed check.

## Other sources reviewed

| Source | Coverage and operating limits |
| --- | --- |
| GLEIF Golden Copy | A public identifier and alias supplement. The live API reported 410,707 LEI records with Indian legal addresses and 194,798 with India’s MCA registration authority `RA000394`, of which 192,856 had active entity status. These are LEI record counts. The exact Infosys CIN returned one registration match. The inspected entity schema exposes legal names, registration identifiers and addresses without an employer website field. Use the Golden Copy for batch joins. [Live MCA filter](https://api.gleif.org/api/v1/lei-records?filter%5Bentity.legalAddress.country%5D=IN&filter%5Bentity.registeredAt%5D=RA000394&page%5Bsize%5D=1) · [Golden Copy downloads](https://www.gleif.org/en/lei-data/gleif-golden-copy/download-the-golden-copy) |
| Wikidata | Public CC0 official website and LEI claims can corroborate known entities. A bounded India-organization query timed out at 35 seconds, so coverage remains unmeasured. Wikimedia directs broad data consumers to dumps. [Official website property](https://www.wikidata.org/wiki/Property:P856) · [Data access](https://www.wikidata.org/wiki/Help:Data_access) · [License](https://www.wikidata.org/wiki/Wikidata:Licensing) |
| Employer reports and exchange filings | Public employer filings can tie a CIN or exact legal name to the company’s site. The Quest Global annual return demonstrates the format. NSE and BSE company directories and annual reports cover listed issuers. STPI and technology-park listings provide further operating-employer leads. [Quest Global annual return](https://www.questglobal.com/wp-content/uploads/2025/02/QGESPL_Annual-return_2024.pdf) · [SEBI filing directory](https://www.sebi.gov.in/curation/corporate_filings.html) · [Existing STPI research](2026-11-16-india-employer-stpi.md) |
| OpenStreetMap India | The Geofabrik PBF was 1.6 GB at review time. ODbL-licensed `office=company` and `website` tags are a possible independent lead source. Coverage and match quality were untested. Use extracts for bulk processing. [India download](https://download.geofabrik.de/asia/india.html) · [License](https://wiki.openstreetmap.org/wiki/Legal) · [Server policy](https://wiki.openstreetmap.org/wiki/OSM_Server_Side_Script) |
| Fliar BI and Jobiwork | Fliar advertises 4,863,273 global company domains, with India accounting for 10.6% of its 3,233,643 known-country records. Its downloadable global sample is 100,000 rows under CC BY-NC 4.0. Full Fliar and Jobiwork feeds require API keys. [Fliar dataset](https://fliarbi.com/datasets/open-company-database/) · [Jobiwork API](https://jobiwork.com/developers/docs) |
| Search and crawl indexes | Brave’s advertised $5 per 1,000 searches implies about $18,694 for a single search per 3,738,721 registry rows before credits, retries, or verification. It requires an API key. Common Crawl’s public index accepts URLs and is suitable for checking paths on already known domains. [Brave Search API](https://brave.com/search/api/) · [Common Crawl URL index](https://www.commoncrawl.org/url-index) |

Use public Places extracts by region and join the legal name or a confirmed alias with state, city, or postal-code evidence. Keep the place ID, release, source and alternative hosts with each lead. Confirm the company identity on its own website or filing before attaching it to a CIN. Once the employer links an anonymously accessible careers page or ATS, verify that it publishes identifiable jobs before enabling hourly sync. Refresh the source extracts in batches independently of job polling. [Public GeoParquet queries](https://docs.overturemaps.org/getting-data/duckdb/)

## Finding websites and careers pages after the one-time scan

Checked 16 November 2026. For known company domains, check navigation, the homepage and about page, sitemaps advertised in `robots.txt`, and careers subdomains linked by the employer. Check standard paths such as `/careers`, `/career`, and `/jobs` for actual hiring content. Verify redirects and ATS boards against the publisher. For domains still missing a link, Common Crawl’s public Parquet URL Index exposes domain, path, crawl date, and HTTP status. Use those fields to find previously indexed paths, then check each candidate on the live site. [Sitemap guidance](https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap) · [Common Crawl URL Index](https://commoncrawl.org/url-index)

For missing domains, the strongest bulk trial is the People Data Labs free company file. The current download advertises 23.8 million global companies. Its schema includes company name, domain, headquarters country, region and locality. The data is CC BY 4.0, and the download page uses a work contact form. India coverage and overlap with our registry still need measurement. Join on a unique legal name and geography, then require corroboration from the company or an issuer filing before marking a domain verified. [PDL download](https://www.peopledatalabs.com/data-lab/dataset/company-dataset) · [PDL schema and license](https://docs.peopledatalabs.com/docs/free-company-dataset)

| Source | What we verified |
| --- | --- |
| Kerala Startup Mission | The first 20 public IT/ITeS profiles each supplied a website. A case-insensitive exact legal-name join in Kerala matched 13 unique active registrations, 12 of which had neither a website nor a careers lead. The 2Hats Logic profile attaches a registered office to its domain, and the employer publishes a live careers page. The cohort covers certified Kerala startups. [Public directory](https://startups.startupmission.in/startups?sector=IT%2FITeS) · [Example profile](https://startups.startupmission.in/startups/pmJe8) · [Employer careers](https://www.2hatslogic.com/careers/) |
| OpenStreetMap | Geofabrik’s India extract is 1.6 GB. Scan it once with Osmium for business features with `name` and `website` or `contact:website`, and use address tags or coordinates to compare geography. Keep the OSM object ID and attribution with the lead. Indian registry overlap remains unmeasured. [Geofabrik India](https://download.geofabrik.de/asia/india.html) · [Website tag](https://wiki.openstreetmap.org/wiki/Key:contact:website) · [Osmium filter](https://docs.osmcode.org/osmium/latest/osmium-tags-filter.html) · [ODbL and attribution](https://www.openstreetmap.org/copyright) |
| Fliar | The provider reports 341,771 domains labeled India. Its downloadable global sample had 6,962 India rows. Of 4,900 rows with a domain, a region and no closed label, the normalized legal-name and state join retained 26 unique active registrations with one domain each. Twenty-five had neither a website nor a careers lead. These are leads awaiting first-party verification. The sample is CC BY-NC 4.0. India export terms and prices were unverified. [Dataset and methodology](https://fliarbi.com/datasets/open-company-database/) · [Sample CSV](https://zenodo.org/api/records/23432219/files/open_company_database_sample.csv/content) |
| Exchange filings | Use the NSE equity and SME lists to identify listed issuers, then extract exact CIN and company domain from issuer disclosures where provided. The employer’s annual return can directly corroborate the link. This serves a listed-company cohort and gives evidence for a specific registration. [NSE security lists](https://betanseapi.nseindia.com/static/market-data/securities-available-for-trading) · [Example annual return](https://www.questglobal.com/wp-content/uploads/2025/02/QGESPL_Annual-return_2024.pdf) |

Use a search API on selected companies that remain unresolved after the bulk joins. Search for the exact legal name or CIN alongside city and state, and confirm the domain against a company page or filing. Brave’s Search tier lists $5 per 1,000 requests and 50 queries per second. One request per 2,126,739 registrations with no lead would cost about $10,634 before free credits, retries or a second query. PDL’s paid bulk enrichment accepts 100 lookups per call and charges for successful matches. The detailed pricing table lists $0.10 per match for the 1,000–10,000 monthly tier. Measure verified websites and careers URLs per paid lookup on a small cohort before purchasing volume. [Brave pricing](https://brave.com/search/api/#plans) · [PDL bulk API](https://docs.peopledatalabs.com/docs/bulk-company-enrichment-api) · [PDL credit pricing](https://support.peopledatalabs.com/hc/en-us/articles/25794271805211-Pricing-credits)

Google Places Text Search supplies `websiteUri` at its Enterprise tier. Google’s Places policy restricts storing response content and exempts Place IDs. Use persistent sources with publishable attribution for the registry and independently confirm employer websites. [Google field pricing](https://developers.google.com/maps/documentation/places/web-service/text-search) · [Places storage policy](https://developers.google.com/maps/documentation/places/web-service/policies)

### Local coverage and read-only trials

After the one-time pass, Postgres showed 3,029 active registrations with a
public careers page, 4,455 with a verified website and no public careers page,
20,584 with a candidate URL and no verified website or public careers page,
and 2,126,739 with neither type of lead. Of the 4,455, 4,374 had no careers URL
recorded. A website check
ties the domain to the registration using a first-party legal name, CIN, or
equivalent issuer evidence. A careers check confirms that the URL shows a
public employer careers page. Vacancy availability is a separate check.

- On 60 sampled verified websites without any recorded careers URL, a bounded
  check found seven public pages. One came from the existing link extractor,
  two from paths in homepage links with different navigation labels, one from
  a sitemap, and three from standard paths that served careers content.
  Three homepages were unavailable to the checker. [Acaira careers](https://www.acaira.com/Career.aspx) · [Frontier sitemap](https://frontierfurniture.in/page-sitemap.xml) · [Frontier careers](https://frontierfurniture.in/career/)
- A legal-suffix-stripped name join on saved Overture Bengaluru and Hyderabad
  extracts produced 2,774 candidate websites for registrations without a lead.
  It required an explicit matching state, one registration per name and state,
  and one candidate domain. In a sample of 20 per state, 13 of 40 sites
  published the full legal name on the homepage, About, or Contact page.
  Twelve reachable sites lacked that evidence and 15 were unavailable to the
  checker. The sample measures the two saved metro extracts. [ICBio About](https://icbio.org/about.html) · [Envision careers](https://www.envisionesl.com/about-us/join-us)

Run the known-domain pass first. For the missing-domain pass, expand the
Overture join and bring in certified startup directories and issuer disclosures.
Keep ambiguous or unreachable candidates with their observed status.
The pilot did not update the registry.
