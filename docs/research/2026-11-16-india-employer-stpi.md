# STPI and Infopark employer directory snapshot

Checked 16 November 2026. The [machine-readable seed](../../deploy/local/india-employers/stpi.json) contains 1,184 observations across five named cohorts and 1,179 distinct name strings after case-folding. Distinct legal companies and hiring organizations can have different identities. Regional labels reflect the scope available in each source.

| Register | Published rows or cards | Saved observations |
| --- | ---: | ---: |
| [STPI Noida jurisdiction IT/ITeS units](https://bhubaneswar.stpi.in/sites/default/files/inline-files/List%20of%20units%20registered%20with%20STPI%20Noida.pdf) | 521 | 515 |
| [STPI Noida jurisdiction EHTP units](https://bhubaneswar.stpi.in/sites/default/files/inline-files/List%20of%20units%20registered%20with%20STPI%20Noida.pdf) | 8 | 8 |
| [STPI Thiruvananthapuram jurisdiction STP units](https://thiruvananthapuram.stpi.in/en/stp-units-tvpm) | 220 | 217 |
| [STPI Gujarat STP units](https://stpi.in/en/list-stp-units) | 35 | 35 |
| [Infoparks Kerala company directory](https://infopark.in/companies) | 409 | 409 |

The Noida PDF was extracted by selecting its two numbered unit tables and verifying consecutive row numbers. Six individual registrants were omitted. The Thiruvananthapuram list contained three exact duplicate names. The Gujarat table identifies 14 Ahmedabad, 9 Gandhinagar, 9 Vadodara, 2 Surat and 1 Vapi units. The STPI records provide employer leads from their published registers, with live identity and hiring status still to be checked. [STPI Noida statutory-services scope](https://noida.stpi.in/en/stpi-noida-statutory-services) · [Gujarat register update label](https://stpi.in/en/list-stp-units)

Infopark's directory was enumerated through all ten published pagination pages. Every tenant card links a company profile and a park-operated tenant-specific jobs page. The seed uses these links directly and retains only company-level fields. The jobs link for 2Base Technologies resolved to the public tenant page with a Senior DevSecOps opening requiring 6–10 years of experience. This spot check shows why the park directory can seed career-page discovery. Tenant links still need individual checks for dated, open, India software postings. [Kerala government's description of Infopark](https://eitd.kerala.gov.in/en/infopark/) · [2Base tenant profile](https://infopark.in/companies-profile/2base-technologies-pvt-ltd) · [2Base tenant jobs](https://infopark.in/jobs/312)

The [all-campus jobs index](https://infopark.in/companies-job) supplies posting dates, deadlines and a stable tenant ID and posting ID for each listing. A ten-page sample reached dates older than the 30-calendar-day window of 18 October through 16 November. It found 191 distinct dated postings with deadlines on or after 16 November. The catalogue's clear-software title filter and early-career title exclusion selected 38 candidates across 22 tenants. Each matched a saved directory tenant ID and the expected tenant and title on its live detail page. Manual reading found 26 with a stated minimum of at least two years, including eight dated 10–16 November. The ignored receipt `.local-data/india-infopark-job-observations.json` records every candidate and its experience status. The counts are observations from the public index and detail pages. The scan made no additions to the local job catalogue.

Some listings call for more careful attribution and classification. A tenant lists a role for a sister company, another listing combines junior and senior tracks, and one backend title opens a detail page describing frontend work. The receipt preserves these distinctions. [Sister-company example](https://infopark.in/company-jobs/details/438/26823)
