# Employer websites across South and West India

Checked on 16 November 2026. These batches attach source URLs to names already in the employer directory. The original employer names and registry evidence are retained. The saved leads include organization and group recruitment pages. Hiring activity requires a separate check.

## Saved observations

| Batch | Saved names | With a recruitment URL |
| --- | ---: | ---: |
| STPI Thiruvananthapuram cohort | 74 | 45 |
| STPI Gujarat cohort | 22 | 18 |
| Previously unresolved Nifty 1000 IT cohort | 48 | 42 |
| Distinct names across the three cohorts | 143 | 104 |

Tata Elxsi appears in two cohorts. The [South and West seed](../../deploy/local/india-employers/resolved-south-west.json) contains 149 source observations for the 143 names. Each row records its evidence URL. [STPI Kerala registry](https://thiruvananthapuram.stpi.in/en/stp-units-tvpm) · [STPI Gujarat registry](https://gandhinagar.stpi.in/list-stp-units) · [Nifty 1000 constituent CSV](https://www.niftyindices.com/IndexConstituent/ind_nifty1000_list.csv)

Technopark publishes a list of 884 company-profile links. Normalizing legal suffixes and punctuation produced 54 exact-name joins to unresolved employers. Ten published an HTTPS website. Of 44 profiles with an HTTP website declaration, 28 led to a reachable HTTPS page whose title, site metadata or primary heading corroborated the employer name. We retained known careers links visible to a visitor and left unreachable, mismatched or different-site redirects unresolved. GTech’s 228 member-profile links added eight website observations using the same method. [Technopark profile index](https://technopark.in/company-crawl) · [Sample Technopark profile](https://technopark.in/company-details/5636?company=GEMINI%20SOFTWARE%20SOLUTIONS%20(P)%20Ltd) · [GTech member listing](https://gtechindia.org/home/getMembers)

The Gujarat and Nifty batches used employer websites, company-owned careers pages or employer filings published by NSE. For example, the issuer disclosures identify Electronics Bazaar as GNG Electronics’ website and RP Tech India as Rashi Peripherals’ website. The first GESIA member page was reachable, while pages 2–7 timed out during this pass. [GNG employer filing](https://nsearchives.nseindia.com/corporate/GNGNSE_03112026202650_Press_Release_Q2FY27_Financial_Results.pdf) · [Rashi employer filing](https://nsearchives.nseindia.com/corporate/RASHI2024_14042026184213_signed_submission_reg_74_5_.pdf) · [GESIA directory](https://gesia.org/members-directory)

## Infopark tenant websites

The [Infopark enrichment seed](../../deploy/local/india-employers/resolved-infopark.json) records 404 corporate website declarations from the ten publicly linked directory pages. Each website field was joined by the park’s existing tenant career URL and matching normalized company name. Bare domains were formatted as HTTPS website leads. These declarations need their own live checks. Five rows lacked a usable single HTTPS declaration in the index. Their existing park career links remain recorded. [Infoparks company directory](https://infopark.in/companies)
