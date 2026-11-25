# Relocation Job Portal MVP Spec

## Goal

Build a private job-search command center that helps Sharath get relocation interviews within 6 months for visa-sponsored senior/staff engineering, AI engineering, founding engineer, and technical consulting roles.

The product should not behave like a generic job board. It should answer one daily question:

What should I do today to increase my chance of getting relocation interviews for safe, family-friendly countries?

## Primary User

Sharath, an India-based senior product engineer and AI systems builder with 11+ years of experience, moving with wife and two children.

Core positioning:

Senior product engineer and AI systems builder who can take ambiguous business problems, design the product, build the system, and ship production AI workflows.

Proof points to support matching and outreach:

- 11+ years of software engineering experience
- Built VocalDesk, an AI phone agent product
- Building V12 Labs as an AI automation consultancy
- Shipped client and partner systems
- Strong fit for product, architecture, customer-facing, and ambiguous startup work

## Target Countries

Version one priority countries:

- Australia
- Germany
- Netherlands
- Ireland
- Sweden
- Denmark
- Japan
- UAE

South America is out of version one.

## Family And Lifestyle Hard Filters

The product must treat these as core relocation filters:

- Safe for families with young children
- Strong healthcare access
- Reasonable childcare and schooling path
- Low corruption and predictable legal system
- Stable visa path for spouse and children
- Spouse work rights where possible
- Realistic path to long-term residence
- English-friendly enough for the first 1-2 years
- Better work-life balance than India startup intensity

## Role Priority

Rank role types in this order:

1. Founding Engineer / Staff Product Engineer at AI startups
2. Senior Full-Stack Engineer with AI/product focus
3. AI Engineer / Applied AI Engineer
4. Solutions Architect / Technical Consultant for AI automation
5. Fractional CTO / Technical Lead only when relocation or visa sponsorship is realistic

## Valid Lead Definition

A lead enters the main pipeline only if it matches these conditions:

- Strong visa sponsorship, relocation, or international hiring signal
- Senior enough for Sharath's experience
- Located in or relocating to a target country
- Product/building-heavy role, not only maintenance or support
- Company looks healthy enough to be worth time

Allow a separate "maybe" bucket for high-fit startups that do not mention sponsorship publicly.

## MVP Product Shape

Build a simple private web app using:

- Next.js
- Supabase
- shadcn/ui
- Stagehand for browser-assisted discovery
- Local cliproxy for AI drafting

Run locally first. Deploy privately later after the core workflow is useful and protected.

## Dashboard

The first screen should be an action dashboard, not a generic jobs table.

It should show:

- Today's top relocation leads
- Best new visa-sponsored jobs
- Companies to contact directly
- Follow-ups due
- Country pipeline health
- Quick actions: refresh jobs, add job, add company, draft outreach
- Warnings: weak visa signal, family-risk city/country, stale application, missing salary/location

## Daily, Weekly, And On-Demand Workflows

Daily output:

- Best new visa-sponsored roles
- Companies worth direct outreach
- Applications to follow up
- Recruiters/founders to contact
- Roles needing a tailored resume or cover note

Weekly review:

- Which countries are producing the strongest leads
- Which role types are getting responses
- Which sources are low quality
- Interviews, replies, applications, and follow-ups
- Whether the 6-month relocation goal is on pace

On-demand refresh should:

- Find new jobs from selected sources
- Refresh tracked company career pages
- Re-score all open leads
- Flag urgent or high-fit roles
- Suggest who to apply to today
- Suggest which companies need founder/recruiter outreach
- Update pipeline metrics

## Scoring

Each lead needs two scores.

Job score:

- Visa sponsorship confidence
- Role fit
- Company fit
- Compensation after cost of living
- Speed to interview
- Likelihood of international hiring

Country/city score:

- Safety
- Healthcare
- Childcare and schooling
- Spouse rights
- English-friendliness
- Long-term residence path
- Cost of living
- Family suitability

A great job in a weak family/country situation should not outrank a strong job in a strong family/country situation.

## Visa Confidence

Visa sponsorship must be a confidence score, not a yes/no field.

Levels:

- Confirmed: job post explicitly says visa sponsorship or relocation support
- Strong: company is on an official sponsor list and hires internationally
- Possible: company has past international hires, but the role does not mention sponsorship
- Weak: company is in a target country, but no clear sponsor signal
- No: role says no sponsorship, local candidates only, or must already have work rights

Remote roles without relocation should go into a separate "Remote, no relocation signal" bucket and should not rank in the main relocation dashboard.

## Data Sources

Version one sources:

- Official country-level sponsor and skilled-worker sources
- Company career pages
- Greenhouse, Lever, Ashby, Workable, SmartRecruiters, Teamtailor
- LinkedIn links and saved searches
- Wellfound and startup job sources
- Curated AI/startup/scaleup company lists
- Manual job and company entry
- Stagehand-assisted discovery for LinkedIn, X, Reddit, and harder job boards

Official sponsor lists should become company discovery engines, not just filters.

## Country-Specific Official Sources

Start with explicit country-specific importers.

- Netherlands: IND recognized sponsors
- Australia: skilled occupation and accredited sponsor-related sources where available
- Germany: Make it in Germany and official skilled-worker context plus company career checks
- Ireland: critical skills occupation context plus company career checks
- Sweden: official employer/work-permit context plus company career checks
- Denmark: positive list and official work-scheme context plus company career checks
- Japan: highly skilled professional context plus company career checks
- UAE: free zone and employer-sponsored visa context, mostly company-driven

## Company Records

Track companies as first-class targets, even before a perfect role appears.

Company fields:

- Name
- Country
- City
- Website
- Careers page
- Sponsor source
- Sponsor category
- Official source URL
- Last checked date
- Visa signal
- Hiring history signal
- AI/product/startup relevance
- Open roles
- Outreach status
- Founder/recruiter contacts
- Notes
- Confidence level

## Job Records

Job fields:

- Title
- Company
- Country
- City
- Remote/hybrid/onsite
- Source URL
- Source type
- Role type
- Seniority
- Visa confidence
- Relocation signal
- Salary if available
- Job score
- Country/city score
- Status
- Resume variant
- Application date
- Follow-up date
- Notes

## People Records

Track people as first-class records.

People fields:

- Name
- Company
- Role/title
- LinkedIn/X/email/source URL
- Relationship status
- Last contact date
- Next follow-up date
- Notes
- Related jobs or companies
- Outreach drafts and history

## Pipeline

Use this pipeline:

1. Discovered
2. Shortlisted
3. Needs tailoring
4. Applied
5. Follow-up due
6. Recruiter replied
7. Interviewing
8. Offer
9. Rejected
10. Archived

A lead should not move to Applied unless the app stores the resume variant, outreach or cover note, application date, and next follow-up date.

## Outreach Policy

Use both job applications and direct contact.

- For startups, AI companies, founding roles, and staff roles: apply and contact founder/recruiter
- For large companies: apply through the official portal first, then contact recruiter if available
- If sponsorship is unclear but company fit is strong: direct outreach first
- If sponsorship is confirmed: apply quickly, then follow up with a concise recruiter message

No auto-applying or auto-messaging in version one.

## Resume Variants

Support four resume variants:

- Staff Product Engineer / Full-Stack
- Founding Engineer
- Applied AI Engineer
- AI Solutions Architect / Technical Consultant

Each job should be linked to one selected resume variant.

## AI Drafting

AI should be semi-automated. It drafts; Sharath approves.

Generate:

- Role-specific resume summary
- Short cover note
- Founder/recruiter outreach message
- Why-me bullets
- Interview talking points

Each draft should be editable and saved against the job or company.

Use editable prompt templates from the beginning.

AI config for MVP:

- Endpoint URL: http://127.0.0.1:8317/v1
- Model: gpt-5.5
- API key placeholder: local-dev-key

If cliproxy is unavailable, the app should still let Sharath manage jobs manually.

## Stagehand

Stagehand is included in the MVP as an assisted discovery connector.

It should:

- Search LinkedIn for visa-sponsored roles using saved search patterns
- Visit company career pages when normal fetching fails
- Search founder/recruiter/company signals on LinkedIn, X, and Reddit
- Capture source links and snippets into the portal
- Mark leads as browser-discovered
- Stop before applying, messaging, posting, liking, or commenting

Reuse existing stored browser profiles:

- Profile root: /Users/sharathreddychalla/.v12labs-agents/profiles
- Profiles: linkedin, x, reddit, gmail, youtube, web-search

If a platform asks for login, captcha, or verification, the connector should stop and show that manual login is needed.

## Weekly Success Targets

A successful week means pipeline movement, not job hoarding.

Targets:

- 30-50 high-quality new leads reviewed
- 10-15 strong applications or direct outreach messages sent
- 10 follow-ups completed
- 3-5 warm conversations started
- At least 1 interview or recruiter screen every 1-2 weeks once running
- Country and source quality reviewed weekly

## MVP Includes

- Private Next.js app
- Supabase database
- Candidate profile
- Country and light city scoring
- Company target list
- Official sponsor-list imports
- Job lead list
- Manual job and company entry
- On-demand refresh
- Job and company scoring
- Daily action dashboard
- Application pipeline
- AI draft generation through local cliproxy
- Editable prompt templates
- Stagehand-assisted discovery using existing profiles
- People/contact tracking
- Resume variant tracking

## MVP Excludes

- Public job board
- Auto-applying
- Auto-sending outreach
- Heavy LinkedIn scraping as the foundation
- Payment features
- Multi-user support
- General social posting or engagement automation

## First Build Sequence

1. Scaffold the private Next.js app with shadcn/ui.
2. Set up Supabase tables for profile, countries, cities, companies, jobs, people, applications, drafts, sources, and prompt templates.
3. Build the action dashboard with seeded sample data.
4. Add manual job/company/person entry.
5. Add scoring fields and simple scoring rules.
6. Add pipeline status updates and follow-up tracking.
7. Add AI draft generation through cliproxy.
8. Add official sponsor importer for Netherlands IND first.
9. Add company-career-page refresh.
10. Add Stagehand-assisted LinkedIn/company discovery using the shared profile folder.
11. Add weekly review page.
12. Deploy privately after local flow is useful.

## Finishing Criteria For MVP

The MVP is useful when Sharath can:

- Open the dashboard and see today's best actions
- Add or import companies and jobs
- See which jobs have strong visa signals
- Track countries and cities separately from jobs
- Move jobs through the application pipeline
- Generate and edit outreach/resume drafts
- Refresh sources on demand
- Reuse existing logged-in browser profiles for assisted discovery
- Review weekly progress toward relocation interviews
