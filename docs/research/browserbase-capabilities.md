# Browserbase capabilities and application bottlenecks

Checked 2026-11-02 against official Browserbase documentation, Stagehand v4
documentation, and installed `@browserbasehq/stagehand` 4.3.0 / Browserbase SDK
types. The current-implementation column records the baseline before the changes
motivated by this assessment. This is not proof of live account entitlement or
employer completion. This research did not change a provider setting or application.

## Finding

We already use Browserbase for managed Chromium, Playwright/CDP access, file
uploads, and exact Stagehand actions. The largest missing capability is a bounded
handoff to the same running browser. Today a question or challenge stops the
worker and its cleanup destroys the session. Adding more browser capacity does
not repair this lifecycle.

| Bottleneck | Available provider capability | Current implementation | Recommended use |
| --- | --- | --- | --- |
| User must select a dropdown or complete a challenge | Interactive Live View | No live view or takeover route | Owner-only handoff in the current session; stop automation while the user acts |
| Worker disconnects during handoff | Keep alive and reconnect | `keepAlive: false`, unconditional release | Persist session identity and a short deadline; reconnect to the same browser |
| Repeated website login | Encrypted Contexts | Fresh profile each session | Later, explicitly opted-in context per account and site |
| Model misses controls in changing forms | Stagehand observe/extract plus deterministic action replay | Custom screenshot/DOM loop; Stagehand only executes approved clicks/fills | Benchmark scoped Stagehand observations as a proposal source; retain backend validation |
| Submission result is uncertain | Live inspection, browser events, logs/replay when enabled | One receipt inspection, then browser released | Observe the existing session again; never click submit again to discover the outcome |
| Resume upload | Playwright direct file upload | Already used | Keep the current in-memory PDF upload |

## Live handoff and reconnect

Live View permits watch, click, type, and scroll on a running browser and supports
embedding in the application. Each tab has its own URL. That directly addresses
manual controls and sign-in without starting another employer application.
[Live View](https://docs.browserbase.com/platform/browser/observability/session-live-view)

**Initial use:** keep the existing worker/browser connection open for at most three
minutes while an authenticated owner acts through Live View. Pause automation
during this window, then re-observe the existing page. This needs neither new
Contexts nor keep-alive/reconnect support. It is deliberately bounded by worker
and provider timeouts; longer asynchronous assistance is a later design.

Desktop input works natively. Browserbase does not officially support mobile
keyboards and documents virtual-keyboard/event-forwarding workarounds. A mobile
user can still benefit from click-based assistance; do not promise full mobile
typing until tested or implemented.
[Mobile Live View](https://docs.browserbase.com/platform/browser/observability/session-live-view#mobile)

The authenticated `sessions.debug(sessionId, { expiresIn })` endpoint can issue
short-lived URLs: accepted TTL is 60–21600 seconds; the default is bounded by the
session lifetime. Treat an interactive URL as a capability: return it only after
account/application ownership checks, avoid logs and Telegram delivery of the raw
URL, and use a short TTL. These access controls are our design recommendation,
not claims that Browserbase enforces the app's account ownership model.
[Live URLs API](https://docs.browserbase.com/reference/api/session-live-urls)

The API reference does not establish one fixed debugger hostname. Consume the
URL from the authenticated API response rather than synthesizing it. An HTTPS
Browserbase-domain check, with no URL credentials and no untrusted user-supplied
URL input, is an additional application guard; verify the actual response host
during acceptance.

`keepAlive` allows reconnection after a client disconnect. It does not save browser
minutes while waiting: explicit release or timeout ends billing. Configure an
application deadline substantially below provider maxima and release on completion,
cancellation, or expiration.
[Keep alive](https://docs.browserbase.com/platform/browser/long-sessions/keep-alive),
[timeouts](https://docs.browserbase.com/platform/browser/long-sessions/timeouts)

Stagehand v4 supports `browserbase.connect({ apiKey, sessionId })`, followed by
`Stagehand.create({ browser })`. With keep alive, `stagehand.close()` detaches its
client, whereas `browser.close()` still ends the session. Thus toggling one setting
is insufficient: the current `remote.close()` and `REQUEST_RELEASE` cleanup must
distinguish a deliberate handoff from completed work.
[v4 browser lifecycle](https://docs.stagehand.dev/v4/configuration/browser#keep-alive)

**Entitlement uncertainty:** Browserbase's keep-alive page says paid plans; the
Stagehand guide says Startup and above; installed SDK comments still use an older
Hobby plan name. Verify the configured production project's entitlement with a
generated session before promising this on a particular paid tier. Current billing
docs list paid-session duration up to six hours and creation/concurrency limits.
[Browserbase plans](https://docs.browserbase.com/account/billing/plans)

## CAPTCHA and human verification

Browserbase supports automatic solving for supported challenges and exposes
start/finish console events. The documentation says this must be used only for
authorized workflows, and success is not universal. Our application explicitly sets
`solveCaptchas: false` and treats challenge frames as a stop.
[CAPTCHA capabilities and requirements](https://docs.browserbase.com/platform/identity/captcha-solving)

Do not blanket-enable solving or silently route around access controls. For this
application, the immediately useful change is to preserve the browser and let the
user complete the challenge through an explicit handoff. If provider solving is
evaluated later, obtain the required per-action authorization and test its event
handling on a synthetic challenge flow first.

## Context persistence is different from a running session

Contexts store cookies, storage, site data, and potentially saved credentials. They
are encrypted at rest, saved on session close when `persist: true`, and persist
until deleted/invalidated. The provider recommends a context per site/login and
avoiding simultaneous login sessions using the same context. Site authentication
can still expire. Contexts are not a guarantee of preserving a live page's DOM or
an in-flight submission.
[Contexts](https://docs.browserbase.com/platform/browser/core-features/contexts)

Keep fresh isolated sessions as the default. Any future saved-login feature needs
explicit user opt-in, account/site ownership mapping, deletion, and concurrency
control. Do not share a context between job seekers or unrelated employer logins.

## Stagehand can do more than execute our selectors

`observe()` discovers structured executable actions for inspection before acting;
`extract()` produces structured page data. Passing an observed `Action` to `act()`
executes deterministically without an additional inference call. Natural-language
`act()` is a distinct inference path. These are current v4 interfaces; old v3
`new Stagehand(...); init()` and `agent()` examples must not be copied into this
4.3 integration.
[Observe](https://docs.stagehand.dev/v4/basics/observe),
[Extract](https://docs.stagehand.dev/v4/basics/extract),
[Act](https://docs.stagehand.dev/v4/basics/act)

Benchmark an optional, scoped observe/extract proposal path against synthetic
dynamic forms and retain our exact-answer, required-control, revision, and final
submit gates. A provider observation is not authority to invent an answer or
change consent. The documented speed pattern is one observation followed by
validated action replay rather than a fresh inference per fill.
[Speed optimization](https://docs.stagehand.dev/v4/best-practices/speed-optimization)

Managed caching exists, but our current deterministic actions already avoid
Stagehand inference and use temporary per-action selectors. Blanket caching is not
the first fix; account-specific content and changed forms require review before
introducing a separate cached path.
[Caching](https://docs.stagehand.dev/v4/best-practices/caching)

The official AI SDK integration uses a persistent MCP process, is experimental,
is not a separately published adapter, and exposes model-authored JavaScript.
It is useful reference material, not a drop-in replacement for our restricted
application tools.
[AI SDK integration](https://docs.stagehand.dev/v4/integrations/agent-frameworks/vercel-ai-sdk)

## Receipt evidence and privacy

Browserbase has live inspection, retained CDP/console logs, and session replay.
The log API's response contains raw request/response bodies, so enabling it would
retain more personal data than our safe task messages. Our session currently opts
out of logs and recordings. Live View remains usable without storing those
artifacts; the documented per-session opt-out works on all plans, while
account-wide ZDR is Enterprise.
[Observability](https://docs.browserbase.com/platform/browser/observability/observability),
[logs API](https://docs.browserbase.com/reference/api/session-logs),
[retention controls](https://docs.browserbase.com/account/enterprise/zero-data-retention)

A network response can corroborate an employer receipt but an HTTP 200, clicked
button, finished browser session, or model claim alone is not submission proof.
Stagehand's navigation `Response` covers the main document; it is not universal
evidence for an AJAX form POST. Existing Playwright/CDP access can observe an
employer response in the same session; validate its meaning and avoid storing raw
candidate payloads.
[Stagehand Response scope](https://docs.stagehand.dev/v4/reference/response)

Browserbase documents Playwright `setInputFiles` directly. The current PDF upload
does not need a new upload service merely to use more of the provider.
[Uploads](https://docs.browserbase.com/platform/browser/files/uploads)

## Implement in this order

1. Three-minute same-session handoff while the worker remains connected,
   short-lived owner-only Live View, explicit automation pause, and cleanup on
   expiry/cancellation. Test ownership denial,
   concurrent resume claims, deadline expiry, stale approval, and no duplicate send.
2. Resume receipt inspection in an already-submitting session after the user's
   challenge completion. Preserve `submission_unknown` if evidence remains absent.
3. For longer human waits, separately validate paid-plan keep-alive/reconnect and
   durable lifecycle claims before changing the initial connected-worker strategy.
4. Scoped Stagehand observation/extraction benchmark for changing controls, using
   generated data and the existing final-submit gate.
5. Optional account/site login Contexts only when repeated authentication is a
   demonstrated bottleneck and the user explicitly enables storage.

Browserbase's managed Agents are a separate alternative: the documented agent
controls browser/search/files/shell tools, and built-ins cannot currently be
disabled or extended. That does not fit our current narrow pre-submit authority
without a separate design and verification exercise.
[Managed Agents architecture](https://docs.browserbase.com/platform/agents/how-it-works)

## Repo evidence

- `lib/server/applications/browser-session.ts`: disposable session settings and
  unconditional cleanup; `withBrowserSession` is the lifecycle seam to change.
- `lib/server/applications/stagehand-actions.ts`: exact backend-approved actions,
  temporary selectors, caching disabled.
- `lib/server/applications/computer-browser.ts`: custom DOM/screenshot observation
  and challenge detection.
- `lib/server/applications/computer-agent.ts`: custom AI SDK tool loop, answer gates,
  deterministic submission handoff, receipt inspection.
- `lib/server/applications/worker.ts`: submission intent committed before clicking,
  receipt persistence, uncertain-send protection.
- Installed `node_modules/@browserbasehq/stagehand/dist/index.d.mts` and
  `dist/index.mjs`: v4.3 connect interfaces and browser ownership/close behavior.

No live account settings, retained-session behavior, or employer-specific success
has been established by this documentation-only assessment.
