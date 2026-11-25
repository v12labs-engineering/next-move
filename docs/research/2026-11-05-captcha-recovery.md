# 2Captcha recovery verification — 2026-11-05

The user requested fixing the existing 2Captcha integration. No employer
application was submitted or resubmitted during this work. The five uncertain
applications from the ten-job batch remain untouched.

The baseline Browserbase test used 2Captcha's public reCAPTCHA v2 Enterprise demo,
with the Browserbase solver disabled. 2Captcha returned a grid answer, but the
existing refresh check rejected it after 80.6 seconds: consecutive observations
had identical DOM signatures and different screenshot hashes. This establishes a
pixel-only mismatch, not the exact origin of every earlier employer failure.
A controlled 800ms selection animation reproduced the same rejection in Chrome.

Changes:
- Challenge and grid captures disable transient animations. Actual DOM and pixel
  fingerprints still guard every action; this does not ignore replaced images.
- Verify gets at most three fresh guarded attempts after a pre-click rejection.
  Changed grid images require a fresh solver task. Frame, URL, instructions,
  dimensions and allowed controls are rechecked.
- Explicit transient HTTP errors get up to three attempts with five-second gaps.
  Failed creates count toward the same three-create budget as replacement grids.
  Poll retries reuse the existing task. All retries share the two-minute budget
  and outer worker deadline. Lost network responses, malformed results and
  non-transient errors are not retried automatically.
- Provider failure logs include method and HTTP status, never the key or body.

Verification: 51 focused CAPTCHA/Telegram tests passed; typecheck and targeted
lint passed. The real Chrome animation regression and 14 Telegram checks passed,
including zero application Submit actions and code entry without screenshots.
Three regression cases were observed failing before the screenshot/Verify fixes;
three additional HTTP-recovery cases failed before bounded retries were added.

Live attempts after the screenshot fix encountered task-creation HTTP failures;
one instrumented attempt established HTTP 520. The final bounded-recovery run
(session `3b31344e-9518-4273-b319-8821f88637d9`) logged two task-creation HTTP 520
responses and exhausted its shared create-attempt budget after 46,995ms. It ended
with no response token and a visible challenge. Another final-preview attempt
timed out before reaching the solver. **No live challenge-clear success was
established in this run.** Synthetic success is not an employer receipt.

Production release: `dpl_EPkddaTkgvQWcLgm7DaQXF3jsawo`. Only the two CAPTCHA
runtime files replace the previously deployed source; unrelated catalogue changes
are excluded. The diagnostic route and snapshot logging are not in production.
The deployment reached READY and both runtime files matched the deployed source
hashes. All four temporary diagnostic previews were removed after testing.

References:
- [Playwright screenshot animation controls](https://playwright.dev/docs/api/class-locator#locator-screenshot-option-animations)
- [2Captcha GridTask contract](https://2captcha.com/api-docs/grid)
- [2Captcha error handling](https://2captcha.com/2captcha-api#error_handling)
