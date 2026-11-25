# Browserbase alternatives for application automation

Checked 2026-11-04 against official product documentation and pricing pages.
This is a documentation comparison, not a measured provider benchmark. No
provider account, browser setting, application code, or employer form was changed.

## Recommendation

**Benchmark Hyperbrowser first and Browserless second.** Hyperbrowser combines
an explicit fast-start claim, built-in residential proxies, paid-plan CAPTCHA
solving, persistent profiles, and live interaction. Browserless documents a wider
named solver catalogue and explicit solving results. These are candidate fits,
not evidence that either completes this application's flows faster or more often.

**Bright Data Browser API is a less suitable default for authenticated job
applications:** password entry is disabled by default, and sessions cannot
navigate across domains. Scrapeless is a useful additional cost candidate, but
its documented CAPTCHA list is narrower than Browserless's.

## Current project baseline

The current `lib/server/applications/browser-session.ts` explicitly sets
`proxies: true` and `browserSettings.solveCaptchas: true`. The current
`docs/application-browser.md` describes managed residential routing and bounded
CAPTCHA event handling. The older `browserbase-capabilities.md` records an earlier
baseline and must not be used to claim these features are currently disabled.
[Current session configuration](../../lib/server/applications/browser-session.ts),
[CAPTCHA event handling](../../lib/server/applications/captcha.ts).

Browserbase's current documentation confirms that `proxies: true` uses its
managed residential network and that supported CAPTCHAs can be solved
automatically. This comparison therefore concerns reliability, latency, coverage
and cost on the target sites, rather than the absence of either feature.
[Browserbase proxies](https://docs.browserbase.com/platform/identity/proxies),
[Browserbase CAPTCHA solving](https://docs.browserbase.com/platform/identity/captcha-solving).

The app needs a controlled browser for multi-step forms, approved PDF uploads,
optional owner-assisted sign-in, bounded human assistance, and receipt evidence.
A page-fetch/unlocking API alone does not replace that browser lifecycle.

## Candidate comparison

| Provider | Residential proxy | CAPTCHA support documented | Speed evidence | Fit for this app |
| --- | --- | --- | --- | --- |
| Hyperbrowser | Built-in on paid plans; custom proxy configuration also supported | Automatic solver on paid plans; manual evaluation targets include Turnstile, Cloudflare Challenge, reCAPTCHA, AliExpress and Amazon | Vendor advertises under 500 ms browser startup; no local measurement | First benchmark candidate; profiles, live view, uploads and CDP are documented |
| Browserless | Built-in residential; separate metering; external proxies also supported | reCAPTCHA variants, hCaptcha, Turnstile/Cloudflare, GeeTest and more through explicit solver types | Docs say CAPTCHA solves can take seconds to minutes; no verified faster-than-Browserbase result | Strong candidate when CAPTCHA breadth and explicit solver status matter |
| Bright Data Browser API | Residential by default; may select datacenter for compliance on some domains | Automatic solving and custom CDP controls; product page names reCAPTCHA, hCaptcha and Cloudflare Challenge | FAQ says difficult initial navigations can take one or two minutes | Good public-data candidate; login and cross-domain restrictions complicate application flows |
| Scrapeless Agent Browser | Managed residential built in; custom proxy option | reCAPTCHA v2, Cloudflare Turnstile, Cloudflare 5s Challenge, AWS Challenge | No comparable startup or end-to-end measurement established | Additional budget candidate; test upload handling and application-specific behavior |
| Browser Use Cloud | Managed residential; custom proxy option | reCAPTCHA and hCaptcha; Turnstile is not a listed solver type; EU automatic solving is off | Vendor republishes a 386 ms session-lifecycle benchmark with its own definition; not comparable to startup alone | Low browser-hour cost; Stagehand v4 extension integration remains unverified |
| Steel | Managed residential via `useProxy`; fixed IP options | reCAPTCHA v2/v3, Turnstile, image text and sliders; several enterprise challenges are detected without solving | No fixed CAPTCHA latency quoted; task timing exposed | Useful API control; stealth browser is Enterprise-only |

The following sections provide the primary sources for each row. Named solver
types indicate documented capability; they do not establish universal success.

## Hyperbrowser

Its website advertises browser readiness in **under 500 ms** and Playwright or
Puppeteer access. This measures a claimed startup characteristic, not page
navigation, CAPTCHA duration, model inference, or full application completion.
[Product overview](https://www.hyperbrowser.ai/)

CAPTCHA solving requires a paid plan. The documentation exposes automatic
solving, bounded manual evaluations, and detection/solved events. Its manual
target list names `turnstile`, `cloudflare-challenge`, `aliexpress`, `recaptcha`,
and `amazon`; it is not an exhaustive automatic-solver compatibility guarantee.
[CAPTCHA solving](https://www.hyperbrowser.ai/docs/sessions/captcha-solving)

Managed proxies and custom proxy servers require a paid plan. Country, US state
and city targeting are documented. Built-in residential access is explicitly
listed on paid pricing plans; a separate residential-proxy subscription is not
needed, but proxy traffic consumes credits.
[Proxy configuration](https://www.hyperbrowser.ai/docs/sessions/proxy),
[Pricing](https://www.hyperbrowser.ai/pricing)

Current public pricing lists Startup at **$30/month**, including $30 of usage and
25 concurrent sessions, and Scale at **$100/month**, including $100 of usage and
100 concurrent sessions. Usage is **$0.10/browser-hour plus $10/GB proxy traffic**.
Agent steps incur additional charges if their managed agent product is used.
Free credits alone do not establish access to paid proxy/solver features.
[Pricing](https://www.hyperbrowser.ai/pricing)

Profiles persist browser state, including logins; uploads have their own remote
session API. These are documented features, not verification of this app's
existing in-memory PDF/hash checks or owner-assistance flow.
[Profiles](https://www.hyperbrowser.ai/docs/sessions/profiles),
[Uploads](https://www.hyperbrowser.ai/docs/sessions/uploads)

US and European browser regions are documented. `asia-south` is restricted to
Enterprise and Select plans. Proxy country and browser compute location are
distinct settings; account region access must be checked for the benchmark.
[Regions](https://www.hyperbrowser.ai/docs/sessions/regions)

Their Stagehand integration example explicitly uses **Stagehand v3**. It supports
CDP in principle but does not prove compatibility with this repo's Stagehand v4.3
extension lifecycle.
[Stagehand integration](https://www.hyperbrowser.ai/docs/integrations/stagehand)

## Browserless

Built-in residential and datacenter routing are available without purchasing a
separate proxy product. Plain connections rotate by request unless sticky routing
is selected; stealth connections are sticky by default. Stable egress is relevant
to a login or multi-step application. Country targeting is documented; city
targeting requires a larger plan.
[Proxy documentation](https://docs.browserless.io/baas/bot-detection/proxies)

Automatic or manual solving is available through CDP. Its named solver types
include reCAPTCHA v2/v3 and enterprise/invisible variants, hCaptcha, Cloudflare,
GeeTest and FunCaptcha, among others. Cloudflare interstitials need explicit
handling rather than relying on normal automatic detection. Docs distinguish
challenge discovery from a confirmed solve.
[CDP solver reference](https://docs.browserless.io/api-reference/cdp-extensions),
[CAPTCHA behavior](https://docs.browserless.io/baas/bot-detection/captchas)

CAPTCHA solving can take seconds to minutes. Use provider events and bounded
timeouts rather than interpreting a running solver as success. The current
Browserbase-specific event listener would need a corresponding provider adapter.
[CAPTCHA guide](https://docs.browserless.io/overview/getting-started/bypass-captchas)

Browser time costs **1 unit per 30 seconds**, residential traffic **6 units/MB**,
and each successful solve **10 units**. All consume the same plan balance. The
pricing page displays Prototyping at **$25/month billed annually**, with 20,000
units and 15-minute sessions; do not describe that as the month-to-month price.
Proxy bandwidth can dominate the bill.
[Unit accounting](https://docs.browserless.io/overview/unit-consumption),
[Plan pricing](https://cloud.browserless.io/pricing)

Playwright/CDP file transfer is documented, including a base64 upload command
and result/error fields. It requires integration testing against our exact
approved-byte validation. Live URL human fallback is also documented.
[File transfers](https://docs.browserless.io/baas/features/file-transfers),
[Human fallback](https://docs.browserless.io/overview/getting-started/bypass-captchas)

## Bright Data Browser API

The service supports Playwright, Puppeteer and Selenium, automatically managing
proxies, fingerprinting, CAPTCHA solving and retries. Use Browser API for browser
interactions; Web Unlocker is a different product and does not replace a session.
[Introduction](https://docs.brightdata.com/products/scraping-browser/introduction)

The product page names reCAPTCHA, hCaptcha and Cloudflare Challenge algorithms.
Public pay-as-you-go pricing is **$8/GB**, with built-in proxies and unlocking.
The displayed Scale package is **$499/month for 71 GB**. Browser instances/time
are not separately billed. Premium-domain traffic can cost more.
[Product and pricing](https://brightdata.com/products/scraping-browser),
[Billing FAQ](https://docs.brightdata.com/products/scraping-browser/faqs)

The current FAQ establishes material limitations:

- Password entry is disabled by default; exceptions need KYC and compliance review.
- A session permits unlimited navigation **within one domain**; changing domain
  needs a new session. Do not repeat older guidance claiming only one navigation.
- Residential is the default, but some domains may use datacenter for compliance.
- Difficult initial navigations may need one or two minutes; there is no
  user-facing setting that guarantees faster browser execution.

These constraints complicate employer-to-ATS redirects and account sign-in, so
this is not the first migration choice. Resume-upload compatibility was not
established in this research.
[Browser API FAQ](https://docs.brightdata.com/products/scraping-browser/faqs)

## Scrapeless Agent Browser

The managed browser supports Playwright/Puppeteer and integrated residential
proxies. Built-in routing is residential only; separate custom proxy configuration
can be used when a different proxy type or static ISP is needed.
[Browser introduction](https://docs.scrapeless.com/en/docs/browser-crawl/agent-browser/introduction/),
[Proxies](https://docs.scrapeless.com/en/docs/browser-crawl/agent-browser/proxies/)

The published CAPTCHA list is reCAPTCHA v2, Cloudflare Turnstile, Cloudflare 5s
Challenge and AWS Challenge. Solving events are documented. This source does not
establish support for hCaptcha or reCAPTCHA v3; do not imply parity with a larger
solver catalogue.
[Supported CAPTCHAs](https://docs.scrapeless.com/en/docs/browser-crawl/agent-browser/supported-captchas/)

The Crawl introduction states Browser uses the same hybrid rates, **starting
from $0.09/hour plus $1.80/GB**, and describes free CAPTCHA resolution. These
are advertised starting rates, not a verified pay-as-you-go quotation. The
pricing page is package-based; the purchased tier, minimum commitment, browser
solver charges and entitlement should be verified before a cost comparison.
[Published starting rates](https://docs.scrapeless.com/en/docs/browser-crawl/crawl/introduction/),
[Pricing](https://www.scrapeless.com/en/pricing)

## Browser Use Cloud

Standalone managed browsers expose CDP for Playwright/Puppeteer and provide
profiles and interactive live view. The vendor reports a **386 ms** lifecycle
benchmark, defined as the sum of medians for create, connect, page load and
release. Its benchmark date is October 26, 2026. This is a published vendor
claim, not a measurement in this project or a directly comparable startup figure.
[Cloud browser](https://browser-use.com/cloud-browser)

The listed automatic solver handles reCAPTCHA and hCaptcha. Turnstile,
FunCaptcha and GeeTest are not listed solver types; bot-wall access through
stealth/proxies is a separate capability. Automatic solving is off in the EU
deployment. A human can take over the same live session if a challenge remains.
[Solver coverage](https://browser-use.com/captcha-solving),
[Waiting behavior](https://docs.browser-use.com/cloud/browser/captcha-handling)

Browser infrastructure costs **$0.02/hour plus $5/GB residential traffic**,
without a subscription or separate CAPTCHA fee. Browser time rounds up to whole
minutes. Hosted agent/model charges are separate from infrastructure; replacing
the browser does not require adopting its managed agent.
[Pricing](https://browser-use.com/pricing)

## Steel

Session configuration provides managed residential routing with `useProxy: true`
and automatic solving with `solveCaptcha: true`, subject to account access.
[Session configuration](https://docs.steel.dev/overview/sessions-api/configuration)

The solver lists reCAPTCHA v2/v3, Turnstile, text images and sliders. DataDome,
Imperva, Amazon WAF and FunCAPTCHA can be detected but are not automatically
solved. The API exposes task timings instead of promising a fixed solve time.
[CAPTCHA coverage](https://docs.steel.dev/overview/stealth/captcha-solving)

Launch has no monthly subscription fee and charges **$0.10/browser-hour,
$10/GB proxy traffic and $3/1,000 solves**, with account verification required
for solver access. Scale is **$250/month plus usage**, includes $100 monthly
usage credits, and charges $0.08/hour, $6/GB and $1/1,000 solves. The stealth
browser is Enterprise-only, so low-tier pricing does not include its strongest
anti-detection browser.
[Pricing](https://steel.dev/pricing),
[Solver access](https://docs.steel.dev/overview/stealth/captcha-solving)

## Stagehand v4 compatibility is a separate gate

This project pins Stagehand 4.3.0 and uses `browserbase.launch()` to install its
bundled extension before creating Stagehand on that browser. CDP compatibility
alone does not establish a replacement for this integration.

Stagehand v4 can attach with `localBrowser.connect()`, but its runtime extension
must be discoverable. Loading the bundled extension during connection requires
a shared filesystem. A remote provider needs a working extension installation
and connection path, or the application needs a different planner integration.
Treat v3 provider examples as a starting point to investigate, not acceptance
evidence for v4. Verify this before investing in a full migration.
[Stagehand browser/extension requirements](https://docs.stagehand.dev/v4/configuration/browser#connecting-over-cdp)

## Verification before a provider change

Use the same generated application corpus, browser compute region, proxy country,
model and exact-answer gates across candidates. Measure session creation/CDP
attach, first usable form, form-fill time, CAPTCHA detection-to-confirmed-clear,
PDF upload correctness, human handoff, receipt confirmation, release, failure rate,
and billed browser/proxy/solve usage separately. Record p50 and p95 and cost per
confirmed generated completion. No real employer submission is needed to prove
basic provider integration; a generated success cannot establish universal portal
compatibility.

Retain isolated account ownership, bounded waits, exact approved uploads, a single
submit click, and unknown-outcome protection. A solved CAPTCHA, successful model
step, or HTTP 200 alone is not an employer receipt.
