# Tsenta public product research

Research date: 1 November 2026. Scope: current first-party marketing, help, pricing, disclosure and privacy pages. This is a feature inventory for comparison with this repository, not proof of Tsenta's submission success or service capacity. No account was created, no authenticated flow was exercised, no application was submitted, and no purchase was made.

## Evidence standard

- **Documented** means Tsenta describes the feature publicly; it does not mean independently tested.
- **Marketing illustration** means a homepage sample, not a real user outcome or measured performance.
- **Uncertain/conflicting** means first-party sources disagree or access is needed.
- Help articles generally show 30 October 2026 updates; sponsorship guidance shows 31 October. The privacy policy is effective 2 October 2026. Retrieval was on the research date, although crawler dates vary.
- Retrieval caveat: the web tool successfully read help articles by following links from `https://help.tsenta.com/` (requests used `/help/<slug>` and reported redirects to `/<slug>`). Later direct opens of either form sometimes failed while clicking the same homepage link still returned the full article. The citations below use the canonical URLs reported by those successful redirects; this research does not establish direct-link availability in every browser or tool.

## Product loop and discovery

Tsenta presents an integrated discovery → materials → employer submission → response tracking product, with web, mobile, messaging, extension and assistant entry points. Its homepage advertises monitoring 50,000+ company career pages. Its animated employer names, match percentages, timings, applicant positions and sample application counts are demonstrations, not verified measurements. [Homepage](https://tsenta.com/)

The help guide describes resume/preferences ranking and numeric match scores, plus accepting a pasted job URL. The cloud agent checks role eligibility, prepares documents, fills supported fields and open questions, then records submission. Resume approval and filled-form approval are separate controls; filled-form pause depends on the employer system. [How applying works](https://help.tsenta.com/how-tsenta-applies-to-jobs)

Freshness is more qualified than the hero promise: Auto Apply runs on schedules up to four times daily, generally within hours, with no universal minutes-after-posting guarantee. Defaults run about one hour after regular job refreshes. The actual coverage, refresh latency and ranking quality were not measured. [Freshness guide](https://help.tsenta.com/how-fast-tsenta-applies)

## Onboarding and applicant identity

Documented setup accepts Google or email signup, a PDF resume below 10 MB, parsed contact/work/education/skills review, missing-field completion and authorization answers. Users choose a resume profile when starting an application. An application password lets the agent create employer accounts where necessary. [Getting started](https://help.tsenta.com/getting-started)

Country-specific authorization includes legal work eligibility, current/future sponsorship, authorization basis and visa type. OPT has a status field. Sponsorship filtering excludes explicit non-sponsoring, citizenship/permanent-residency-only and clearance-restricted roles while leaving unknown sponsorship visible. Labels include sponsorship/no sponsorship/case-by-case; no sponsorship outcome is promised. [Authorization settings](https://help.tsenta.com/work-authorization-and-visa-sponsorship)

## Resume and cover-letter system

Documented modes are Off, Honest and Aggressive; the last may stretch claims and requires careful review. Review highlights changes and summarizes edits, supports direct edits or chat instructions, and allows using the original instead. Persistent instructions can be saved, edited or removed in settings. Multiple resume profiles support creation, duplication, renaming, import, deletion and a default. PDF-based profiles can later import DOCX templates, with formatting caveats; persistent tailoring preferences do not apply identically to DOCX-based profiles. Cover letters are generated when the form accepts/requires them. [Tailoring guide](https://help.tsenta.com/resume-tailoring-and-cover-letters)

The changelog separately documents editable filled-form review, including answers, work history, education and materials, followed by explicit approval. It names Greenhouse, Workday, Ashby, Lever, Oracle and SmartRecruiters among supported review systems. This does not establish review support everywhere. [Changelog](https://tsenta.com/changelog)

## Application execution and receipts

The supported-platform guide names 56 systems, while marketing generally says 30+. Examples include Workday, Greenhouse, Lever, Ashby, iCIMS, Oracle Cloud, SAP SuccessFactors, SmartRecruiters, Taleo, ADP, Workable and Rippling. Listed platform support does not guarantee every employer form works. The dashboard is the eligibility authority for a specific job. Tsenta excludes LinkedIn Easy Apply; job-board links resolve to employer systems. Employer account creation and temporary platform holds are documented. [Supported systems](https://help.tsenta.com/supported-job-sites-and-ats)

Records can include entered fields, generated answers, the resume and cover letter used, and confirmation/result. Completeness varies by ATS. Starting or filling an application is not submission proof. Submitted applications cannot be changed, resubmitted or withdrawn through Tsenta. Cancelled/skipped unsent applications may be retried with another profile. [Application records](https://help.tsenta.com/application-records)

The disclosure additionally advertises live overlays or headless execution with later replay, ATS scoring for parseability/headings/keywords, and web/email/push/iMessage notifications. These were not exercised. CAPTCHA handling, exact takeover mechanics, credential security implementation and measured per-ATS success rates remain unknown. [AI disclosure](https://tsenta.com/ai-disclosure)

## Auto Apply

Auto Apply requires Power and is still gradually rolling out. Documented controls:

- Up to five searches, with separate filters and resume profiles.
- Include/exclude keywords, role types, location/remote, employment type, company allow/deny lists, experience, posting age and sponsorship.
- Match thresholds: Excellent 75+, Strong 66+, Good 60+, Stretch 55+; default Excellent.
- Daily cap 1–150, default 10; maximum 60 per run.
- One to four runs per day with timezone controls; defaults use Eastern time.
- Default posting age 24 hours; per-company limit 1–50 in 30 days, disabled by default.
- Interview company pause 7–180 days, default enabled for 60 days.
- Own resume settings; manual resume review skipped, but per-search form review can be enabled.
- Subsequent applications to a company reuse its latest submitted resume for one year.

[Auto Apply guide](https://help.tsenta.com/turn-on-auto-apply)

## Tracker, inbox and recruiter assistance

Tracker stages are Applied, Interviewing, Offer, Rejected and Ghosted. Users can add outside applications, import CSV and correct stages manually. Email matching uses job ID, existing linked thread, unique company application, or company plus title. Confident interview/rejection/offer classification moves stages forward; generic recruiter mail alone does not. [Tracker guide](https://help.tsenta.com/track-job-applications)

The email guide documents private application inbox addresses, forwarding, message search/reply, optional Gmail/Outlook connections and employer OTP extraction. Application address depends on whether connected mailbox and profile email match. [Email guide](https://help.tsenta.com/connect-email-recruiter-replies)

**Conflict requiring live verification:** that guide says personal mailbox connections read verification codes rather than import mail, so personal-address replies need manual tracking. The privacy policy and homepage describe broader Gmail job sync, automatic tracker updates and recruiter draft generation. Do not assume equivalent Gmail and Outlook capabilities from these sources.

The privacy policy describes Gmail readonly/compose scopes, classification of new mail plus a 30-day lookback, AI processing of sender/subject/category/preview and sometimes openings, storage of job-related messages, draft generation without autonomous sending, disconnect/revocation, and deletion of non-job check records within 45 days. Synced job-related mail remains until account deletion. It names AI, payment, hosting and email subprocessors. This is a policy statement, not a security audit. [Privacy](https://tsenta.com/privacy)

## Channels and networking

The Chrome extension detects roles on LinkedIn, Indeed, Glassdoor, Wellfound, Dice, hiring.cafe and recognized employer pages; it sends the role to cloud execution rather than typing into the local tab. It does not need job-board passwords. Optional apply-on-open is off by default and has a confirmation. Recognizing a page does not guarantee submission eligibility. [Extension guide](https://help.tsenta.com/chrome-extension)

iPhone/Android document swipe-right apply, swipe-left pass with last-pass undo, a refine control, application/inbox tabs, review, Auto Apply where available, and push notifications for submission/review/pause. Some settings arrive on web first. [Mobile help](https://help.tsenta.com/iphone-and-android-apps)

Messaging documents account linking with emailed six-digit code, PDF under 5 MB or LinkedIn URL onboarding, conversational discovery/apply/status and multi-job confirmation such as applying to the displayed list. The user starts each conversation; the guide says Tsenta does not initiate texts. [Messaging help](https://help.tsenta.com/apply-by-imessage-and-whatsapp)

Remote Streamable HTTP MCP with OAuth is documented at `https://api.autojobs.me/api/v1/mcp`. Tools cover profiles, resumes, jobs, applications, tracker, inbox and allowance. Networking finds company contacts, returns work email only if verified and saves email/LinkedIn drafts; it does not send outreach. The public guide does not enumerate tool schemas. Connector revocation guidance conflicts: help suggests support, while privacy says settings revocation is immediate. [MCP help](https://help.tsenta.com/connect-claude-chatgpt-mcp)

## Plans and commercial operations

Advertised monthly USD plans: Free 25 lifetime successful applications; Starter $19/600 per 30-day cycle; Pro $39/1,500; Power $99/4,500 plus Auto Apply. Other core features and surfaces are included across plans. Networking daily allowances are 10/10/25/50 respectively. Quarterly/annual options exist; application allowances do not roll over. [Pricing](https://tsenta.com/pricing)

Billing documentation adds automatic allowance refunds for failed/skipped/unsent-cancelled applications, paid-web-plan credit purchases from $5 with nonexpiring credits, web subscription pause, immediate prorated upgrades, next-cycle downgrades, payment failure holds, and distinct store subscription management. The detailed cancellation guide includes reason selection, possible pause offer and confirmation despite marketing saying one-click cancellation. [Billing guide](https://help.tsenta.com/billing-refunds-and-cancelling)

## Limits of this research

Public documentation supports a substantial target feature set, but cannot establish operational parity criteria by itself. The next verification layer would require an authorized test account, observed onboarding/settings, representative ATS dry runs, receipt inspection, inbox test fixtures, actual rollout availability and latency/cost/success measurements. No claim here establishes interview rates, applicant rank, guaranteed freshness, universal ATS success or the economics behind advertised prices. The documentation index loaded, but its linked `llms.txt` was inaccessible through the web tool; help articles supplied the detailed evidence instead.
