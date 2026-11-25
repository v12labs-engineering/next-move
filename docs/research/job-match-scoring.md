# Job match scoring: platform research and implications

Researched 2026-10-31 using first-party product documentation and the current repository. This is research and a proposed direction, not an implemented scoring change or a comparative accuracy benchmark.

## Finding

The reviewed products measure different things under similar labels: resume wording coverage, qualification alignment, personal preferences, and recommendation relevance. Their numbers are not interchangeable. Our listing should primarily answer whether the candidate's documented experience covers the job's requirements, while showing practical eligibility and preferences separately. This is our design inference from the evidence below.

The biggest immediate problem in our implementation is the direction of skill coverage: it measures how much of the candidate's entire skill list appears in a job, rather than how much of the job's requirements the candidate can demonstrate. A broader candidate profile can therefore lower the score without changing suitability for that job.

## What others publicly document

| Product and context | Documented approach | Useful lesson and disclosure limits |
| --- | --- | --- |
| LinkedIn, candidate-facing job match | Compares required/preferred qualifications from descriptions and screening questions with the candidate's profile and resume; returns a rating and explanation. Hirers cannot see this candidate-facing rating. [Official help](https://www.linkedin.com/help/linkedin/answer/a7120158) | Start from qualifications and evidence. Exact weights are not disclosed. Top Applicant/relative applicant insights should not be equated with simple requirement coverage. |
| Indeed, candidate-facing matching | Match overview compares skills, experience, licenses and certifications. Job-card checks separately show agreement with pay, location and schedule preferences. A qualification gap does not stop someone applying. [Official guide](https://www.indeed.com/career-advice/finding-a-job/indeed-tips) | Distinguish ability to do the job from whether the job suits the person. The reviewed guide does not publish a numerical formula. |
| Welcome to the Jungle, job recommendations | Describes three stages: non-negotiable contract/experience/remote/location filters, title-or-background relevance, then ranking by title, experience, shared skills and supplied cultural preferences. Title is explicitly most important. [Official explanation](https://help.welcometothejungle.com/en/what-is-job-matching-) | Filtering and ranking are different operations. No numerical weights are published; its title emphasis also shows there is no single universal industry weighting. These docs do not establish the historical Otta algorithm. |
| Jobright, candidate-facing recommendations | Uses target role/preferences with resume, experience, skills, seniority and industry background. Explanations address relevant experience, seniority, skills and gaps. Preferences include location, remote options, job type and salary. [Official product explanation](https://jobright.ai/ai-job-match) | Broader professional relevance than title or keywords alone. Dimensions are public; the full weighting and model are not. |
| Huntr, resume-to-job assessment | Evaluates qualifications, responsibilities, keywords and title using LLMs. Required versus preferred items have different importance; qualifications account for roughly one-third to one-half and keywords usually less than one-fifth. Explanations identify supporting resume passages. [Official help](https://help.huntr.co/en/articles/12241684-job-match-score) | The clearest reviewed example of requirements and responsibilities outweighing keyword overlap. Its Poor–Great bands are product labels; the documentation does not independently establish hiring probabilities or applicant percentiles. |
| Jobscan, resume optimization | Prioritizes hard skills, education when the posting specifies an advanced degree, title, soft skills and other keywords. It separates some content advice from factors that affect the match rate. Predicted skills absent from the actual description do not affect the rate. [Official tutorial](https://www.jobscan.co/jobscan-tutorial) | Useful wording/coverage feedback, not a disclosed universal employer screening formula. Its recommended score target belongs to its own tool. |
| Simplify, resume feedback | Distinguishes Keyword Match, which covers extracted job terms, from a broader Resume Score incorporating content/structure/formatting when available. It explicitly says these are not an employer's ATS score or interview prediction. [Official scoring explanation](https://help.simplify.jobs/en/help/articles/2175778-understand-resume-score-and-keyword-matching) | State exactly what a score measures and what could be assessed. The combined score can fall back to available components; its numeric output should not be treated as qualification probability. |
| Dice, candidate-facing tech job fit | Compares profile/resume qualifications with the description using a taxonomy relating skills and titles. The candidate's match score is private to them. [Official help](https://www.dice.com/support/candidate-help/finding-a-job/dice-match.html) | Normalize related titles and skills rather than requiring literal equality. This is tech-specific; its documentation does not disclose a complete formula or an independently reproducible accuracy benchmark. |
| Textkernel, matching infrastructure | Search & Match V2 documents weighted criteria, hard must-have/must-not-have conditions, softer preferred conditions, context-dependent weights, recent-title boosting and semantic signals. The displayed 30% title weight is explicitly illustrative. [Technical documentation](https://developer.textkernel.com/tx-platform/v10/search-match-v2/overview/) | A staged, explainable rules/model combination is a documented option; an opaque LLM-generated total is not necessary. Do not copy illustrative weights as production defaults. V2 is labeled Beta in the reviewed docs. |

Teal also separates resume quality from job-specific matching, reinforcing that these are different measures. Its analyzer documentation links to a matching article that returned 404 during review; no detailed formula is inferred from that link. [Teal analyzer help](https://help.tealhq.com/en/articles/9524748-using-the-resume-analyzer)

An employer-side example is useful but must remain distinct: LinkedIn Hiring Pro evaluates must-have and preferred qualifications, indicates uncertainty with a question mark, and shows whether evidence came from a profile, resume or screening answer. It can apply configurable qualification thresholds. This is employer applicant sorting, not disclosure of the candidate-facing job-match algorithm. [Hiring Pro FAQ](https://www.linkedin.com/help/linkedin/answer/a7463744)

These are vendor descriptions of intended behavior. They do not prove that a competitor is more accurate than ours, reveal proprietary weights, or establish a common ATS pass mark. I did not test paid accounts or measure hiring outcomes.

## Current implementation: confirmed limitations

Code references are repository-relative; synthetic examples below were executed against the current `matchJob` function, without changing it.

- `lib/matching/index.ts:155-160`: skill points are `round(25 × matching candidate skills / all candidate skills)`. There is no structured list of required job skills in this calculation, no required/preferred weighting, and no evaluation of evidence depth or recency.
- `lib/matching/index.ts:24-84`: title matching uses normalized phrases, stripped seniority and a limited software-family relationship. Broader profession and transferable-experience matching is not present in this function. The title relevance gate runs before description scoring in `lib/server/account-store.ts`, so improving only the final scorer would not recover jobs excluded earlier.
- `lib/matching/index.ts:92-96`: target country adds 20 points even though target-country membership already constrains new recommendations. This supplies a largely constant bonus rather than distinguishing professional suitability.
- `lib/matching/index.ts:166-180`: sponsorship adds 10 points even when sponsorship is unnecessary. Work mode supplies another 10 when explicitly stated and accepted.
- `lib/matching/index.ts:191-225`: a narrow experience regex affects the eligibility flag, not the numeric score. Unknown candidate experience passes the duration check with a warning. Skills and complete descriptions are not required for the Strong fit flag.
- `components/jobs/match-score.tsx:14-24` and `components/jobs/job-row.tsx:32-38`: the ring describes the number as a percentage of fit and colors scores at 70+, while Strong fit comes from a separate boolean. Neither is calibrated to interview likelihood.
- `lib/applications/auto-apply.ts:25-36`: the score also affects unattended application eligibility. A scoring change therefore needs application-threshold review, not just a new visual label.

### Executed synthetic examples

Baseline: Backend Engineer targeting Germany, five years' experience, Python/Postgres skills, hybrid preference, sponsorship required. Listing: matching title/country/mode, confirmed sponsorship, both skills and a three-year experience requirement. These fixtures are invented to isolate behavior; they are not candidate or employer records.

| Change from baseline | Current score | Current Strong fit flag |
| --- | ---: | --- |
| None | 100 | Yes |
| Add eight unrelated skills to the candidate profile | 80 | Yes |
| Remove both skill mentions from the description, retain experience requirement | 75 | Yes |
| Remove the description entirely | 75 | Yes, with an incomplete-evidence warning |
| Candidate has one year rather than five | 100 | No |
| Candidate's experience duration is unknown | 100 | Yes, with a warning |
| Candidate does not need sponsorship; listing sponsorship is unconfirmed | 90 | Yes |

The first two rows demonstrate a score falling despite unchanged job requirements and unchanged supporting qualifications. The experience rows demonstrate that a maximum score can coexist with a material mismatch or an unknown. The code already surfaces some warnings; the issue is that the total and fit label do not consistently communicate them.

## Recommended direction for this product

This is a proposal, not a claim that all competitors implement the same architecture.

1. **Separate practical eligibility, qualification fit and personal preferences.** Track confirmed constraints such as location, explicit sponsorship restrictions and required credentials separately. Show unmet preferences without presenting them as a lack of competence. Treat remote work as constrained by actual hiring geography, not inherently worldwide. Preserve unknown facts for review rather than silently passing or rejecting them.
2. **Score coverage of explicit job requirements against candidate evidence.** Extract required/preferred skills, responsibilities, experience scope, seniority and explicit credentials/languages. Weight core requirements above optional items. Additional unrelated candidate skills must not lower coverage of unchanged job requirements. A missing resume statement means evidence is missing, not proof that the candidate lacks the ability.
3. **Use semantic matching with traceable evidence.** Normalize aliases and profession relationships; compare responsibilities with source resume passages. Use models for bounded extraction/semantic comparison where useful, then calculate totals using versioned, inspectable rules. A title should help retrieve and rank without being the sole route into consideration. Avoid a free-form prompt that simply invents an overall number.
4. **Expose evidence status and assessment completeness.** Each important requirement should be supported, partially supported, not demonstrated, or unknown/unassessable, with source passages and correction controls. A missing description should produce an incomplete assessment. Do not renormalize a tiny known subset into an apparently complete 100-point result. Completeness is a measured input-coverage indicator, not a model's self-reported confidence or a hiring probability.
5. **Keep discovery freshness separate from qualification fit.** It can guide which equally suitable roles to review first, but a recently collected job is not intrinsically a better qualification match. Keep discovery time distinct from employer posting time.

An appropriate listing might say “Strong qualification match · 4 of 5 required items supported · sponsorship unconfirmed.” This is illustrative copy, not a proposed numerical calibration. Optional skills should not compensate for an explicit essential restriction, while uncertain facts should remain visibly uncertain.

There is not enough evidence here to select a defensible universal weight split, a pass mark, or a probability model. Different products visibly prioritize different criteria. Choose our weights using relevant examples rather than replacing one arbitrary formula with another.

## Verification before implementation

Create a small, manually reviewed benchmark spanning multiple professions, seniority levels and destination/sponsorship situations. Include incomplete descriptions, alternate titles, required licenses, transferable responsibilities, missing/negated skills and unknown candidate experience. Keep an evaluation subset separate from examples used to tune weights.

Compare the current scorer with the proposed scorer on top-result relevance, erroneous exclusions, missed explicit restrictions, evidence accuracy and score stability. In particular, verify that adding an unrelated candidate skill cannot reduce requirement coverage, repeating a keyword cannot dominate the score, and missing evidence cannot produce an unqualified complete-fit claim. Report measured results; this research provides no evidence of an achieved improvement.

Keep the existing background/published-generation architecture described in `docs/precomputed-matches.md`. Extract reusable listing requirements once per description version and ground candidate evidence in the saved profile/resume. Version the scoring policy and rebuild results after changes. Reassess auto-apply eligibility and thresholds before using a changed score for unattended sends. These are implementation recommendations, not work performed in this research.

## Verification performed for this note

Reviewed the cited first-party pages, traced the current scoring, fit labels, stored sorting and automatic-application threshold, and executed the seven synthetic cases above with the installed TypeScript runtime. No application logic, database, provider configuration or deployment was changed.
