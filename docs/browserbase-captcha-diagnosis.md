# Browserbase CAPTCHA diagnosis — 2026-11-04

This report records the initial Browserbase-only investigation. The user later
authorized a funded 2Captcha fallback; subsequent production changes and real
SewerAI test outcomes are documented in [application-browser.md](application-browser.md#funded-2captcha-test-on-sewerai--2026-11-04).

## Finding

The deployed paid credentials can obtain a reCAPTCHA response on Google's
standard demo, including through this application's Stagehand session and public
request guard. The same credentials repeatedly produce
`browserbase-solving-started` then `browserbase-solving-errored` on FAR.AI's
invisible reCAPTCHA Enterprise widget at `www.recaptcha.net`.

The failure reproduces using only the Browserbase SDK and Playwright: no
Stagehand, model calls, request interception, candidate information or Submit
click. This isolates the failure to the Browserbase/Ashby verification path; it
does not establish that every Enterprise widget is unsupported. Browserbase's
public error event provides no internal solver reason.

## Controlled results

All sessions requested managed proxies and `solveCaptchas: true`, disabled
recordings/logging, and used the linked project's deployed credentials inside
protected Vercel previews. Observations record whether the response field became
nonempty; this is not evidence of an accepted employer submission.

| Target | Browser setup | Region | Observed result |
| --- | --- | --- | --- |
| Google standard demo | Application Stagehand session | Singapore | Response token present, no request failures |
| Google standard demo | Browserbase SDK + Playwright only | Singapore | Response token present, no request failures |
| Google standard demo | Stagehand + application network guard | Singapore | Response token present, no request failures |
| FAR.AI / Ashby | Browserbase SDK + Playwright only | Singapore | Solver errored after 8.24 seconds; no token; challenge remained |
| FAR.AI / Ashby | Application Stagehand session | Singapore | Solver errored after 8.05 seconds; no token; challenge remained |
| FAR.AI / Ashby | Browserbase SDK + Playwright only | Oregon | Solver errored after 4.03 seconds; no token; challenge remained |
| FAR.AI / Ashby | Third-party cookie restrictions disabled with CDP | Singapore | Setting accepted; same solver failure and storage errors |
| FAR.AI / Ashby | Origin-specific storage-access permission granted | Singapore | Storage errors disappeared; same solver failure and no token |
| FAR.AI / Ashby | Challenge requests redirected to Google's canonical domain | Singapore | Actual Enterprise frames moved to `www.google.com`; same solver failure and no token |
| FAR.AI / Ashby | Verified browser requested | Singapore | Session creation rejected with HTTP 403; Verified unavailable on this account |

IP observations showed US ISP networks including AT&T, Comcast, Verizon and RCN.
The SDK's actual session-create request preserved the proxy flag, solver flag,
region and correct project. Every completed session still reported zero proxy
bytes. That counter is not sufficient to diagnose whether proxy routing worked.
The tests did not establish the classification of every observed exit address.

The storage-access error is not the cause in the permission test: removing the
error did not clear the CAPTCHA. Moving regions and removing our application
layers also did not clear it. Moving the actual Enterprise frames to Google's
canonical domain did not clear it either. No speculative cookie, permission,
domain or region change was adopted in the application runtime.

## Provider reproduction

The failing public page is:
`https://jobs.ashbyhq.com/far.ai/a94080f7-288b-4a98-ad4a-aaaa4bbf9968/application`.
Load it without filling or submitting anything. Register the console listener
before navigation, wait up to 40 seconds, and inspect the response field and
remaining Enterprise challenge. Compare with
`https://www.google.com/recaptcha/api2/demo` in a separate fresh session.

The minimal failing setup is `@browserbasehq/sdk` 2.23.0 and `playwright-core`
1.64.1 on Node 24. Create the session with:

```ts
const session = await bb.sessions.create({
  projectId: process.env.BROWSERBASE_PROJECT_ID,
  proxies: true,
  region: "ap-southeast-1",
  api_timeout: 150,
  keepAlive: false,
  browserSettings: {
    solveCaptchas: true,
    recordSession: false,
    logSession: false,
  },
})
const browser = await chromium.connectOverCDP(session.connectUrl)
const page = browser.contexts()[0].pages()[0]
page.on("console", (message) => {
  if (/^browserbase-solving-(started|finished|errored)$/.test(message.text()))
    console.log(message.text())
})
// Navigate to one of the fixed public pages above; do not fill or submit.
// Close the browser and request session release in finally.
```

Use current server credentials, not the stale local environment. Never print
the API key, connection URL, signed Live View URL or response-token value.

Provider investigation examples, all released after the test:

| Session | UTC start | Case |
| --- | --- | --- |
| `7900e10e-406b-4102-923f-688644051508` | 05:49:58 | Google standard demo through Stagehand, token present |
| `d8405214-13c5-483e-9a0f-390a49c2bc44` | 05:53:51 | Google standard demo with the network guard, token present |
| `41b0398e-7c5e-4e0d-92b7-59b29791ff0c` | 05:54:16 | Ashby with plain SDK, solver error |
| `367cc728-9558-45d7-8cd4-748f2ec97701` | 05:55:07 | Ashby with Stagehand, solver error |
| `c4049afe-5fd5-45b3-9ecf-51247ee92287` | 05:56:48 | Ashby with plain SDK in Oregon, solver error |
| `f66fcc84-1b3d-4349-a3e4-0c4988f5a127` | 06:00:43 | Ashby after storage permission removed console errors, solver error |
| `ac885321-ce99-4203-9a83-6cef9f3fe326` | 06:03:25 | Ashby with actual Enterprise frames on `www.google.com`, solver error |

Sanitized detailed results are retained in ignored `.local-data/captcha-probe-*.json`
files. The earlier real application remains `submission_unknown`, without a
receipt, and was not retried during this investigation. No new employer
application was sent. The user requires a Browserbase-only solution; no new
fallback service or subscription was configured.

## Remaining provider action

No tested application configuration fixed the failure. Browserbase needs to
inspect the internal solver error for the plain-SDK failing sessions above and
compare them with the successful standard-demo sessions. Specifically, confirm
support for this invisible Enterprise widget on the current plan and identify
the required supported configuration or a provider-side correction. The public
console event alone cannot distinguish an unsupported challenge from an internal
solver-service failure. Verified is a candidate to evaluate after account access
is enabled; its success on this challenge has not been established.

The temporary diagnostic routes and their five preview deployments were removed
after collecting the results. Production was not promoted or reconfigured.

Browserbase documents [the solver event contract](https://docs.browserbase.com/platform/identity/captcha-solving),
[bounded solver waits](https://docs.browserbase.com/optimizations/captcha-solving-for-agents)
and [Verified account availability](https://docs.browserbase.com/platform/identity/overview).
These describe supported behavior, not proof that this failing challenge clears.
