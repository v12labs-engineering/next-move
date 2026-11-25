# India employer seeds from YC and NSE Indices

Collected on 16 November 2026. The [industry seed](../../deploy/local/india-employers/industry.json) contains 209 distinct employer names across two public source cohorts. Each record cites its directory evidence. The records establish employer leads for career-page checks. India job locations, software-role eligibility, and openings require evidence from the employer's career site.

| Source cohort | Public records read | Employer leads saved |
| --- | ---: | ---: |
| Y Combinator India-headquartered directory, four pages | 177 | 157 |
| NSE Indices Nifty 1000 constituent CSV | 1,000 | 52 |

The YC page's embedded company records reported 155 Active, two Public and 20 Acquired companies. The seed keeps the Active and Public records. It preserves each company's YC profile as evidence, the listed city where supplied, and the explicitly supplied HTTPS company URL where available. That produced 147 city labels and 136 company URLs. Nineteen HTTP-only URLs and two missing URLs remain unresolved. The cohort covers YC-backed companies listed as headquartered in India and includes companies from outside the software sector. [YC India directory](https://www.ycombinator.com/companies/location/india)

The Nifty 1000 seed keeps every row that NSE Indices labels Information Technology. The 52 retained names and symbols were distinct. The CSV gives the listed company name and industry, with no website or city field. Its listed-company scope excludes privately held and non-IT companies that also hire software engineers. [Nifty 1000 index](https://www.niftyindices.com/indices/equity/broad-based-indices/nifty-1000) · [Official constituent CSV](https://www.niftyindices.com/IndexConstituent/ind_nifty1000_list.csv)
