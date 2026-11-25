import assert from "node:assert/strict"
import { readFile, writeFile } from "node:fs/promises"
import { parseEnv } from "node:util"
import {
  fillApplicationIdentity,
  fillApplicationProfile,
} from "../../lib/applications/answers"
import { applicationProfileSchema } from "../../lib/applications/profile"
import { chromium } from "playwright-core"
import { withBrowserSession } from "../../lib/server/applications/browser-session"
import {
  discoverComputerForm,
  runComputerApplication,
} from "../../lib/server/applications/computer-agent"
import { profileAnswers, type ApplicationPacket } from "../../lib/applications"
import { formHash } from "../../lib/server/applications/browser"
import { getVercelOidcToken } from "@vercel/oidc"
import { createHash } from "node:crypto"
import { applicationFormPlanner } from "../../lib/server/applications/form-planner"
import { applicationFailure } from "../../lib/applications/pipeline"
import {
  bindBrowserUse,
  browserUseRunner,
} from "../../lib/server/applications/browser-use"
import { createServer } from "node:net"

// Real screenshots + actual model; only generated HTML/data, no employer contact.
const environmentFile =
  process.argv
    .find((arg) => arg.startsWith("--env-file="))
    ?.slice("--env-file=".length) || ".env.staging.local"
const env = parseEnv(await readFile(environmentFile, "utf8"))
const gateway = parseEnv(
  await readFile(".local-data/computer-gateway.env", "utf8")
)
// Refresh only a short-lived project token in memory. This does not download
// production environment variables or persist a new credential file.
if (process.argv.includes("--refresh-oidc"))
  gateway.VERCEL_OIDC_TOKEN = await getVercelOidcToken({
    project: "prj_y2XdyM0PSbTvcLIT70cX9pKTz6CE",
    team: "team_xP5ofTY8NOOv2tFfvu6RJrBL",
  })
Object.assign(process.env, {
  BROWSERBASE_API_KEY: env.BROWSERBASE_API_KEY,
  BROWSERBASE_PROJECT_ID: env.BROWSERBASE_PROJECT_ID,
  APPLICATION_BROWSER_PROVIDER: "browserbase",
  TAILORING_BASE_URL: env.TAILORING_BASE_URL,
  TAILORING_MODEL: env.TAILORING_MODEL,
  VERCEL_OIDC_TOKEN: gateway.VERCEL_OIDC_TOKEN,
  APPLICATION_COMPUTER_MODEL:
    process.env.APPLICATION_COMPUTER_MODEL || env.APPLICATION_COMPUTER_MODEL,
  APPLICATION_RECEIPT_MODEL:
    process.env.APPLICATION_RECEIPT_MODEL ||
    env.APPLICATION_RECEIPT_MODEL ||
    "",
})
const nameLayout = process.argv
  .find((arg) => arg.startsWith("--name-layout="))
  ?.split("=")[1]
assert.ok(
  !nameLayout || ["full", "split", "compound", "temporal"].includes(nameLayout),
  "Unknown name layout"
)
const fullName =
  nameLayout === "compound" ? "Test Middle Candidate" : "Test Candidate"
const source = `${fullName}\nEmail: synthetic@example.test\nPhone: +91 98765 43210\nLinkedIn: linkedin.com/in/synthetic-computer-candidate\nGenerated fictional QA engineer. Built TypeScript APIs and SQL services.`
const profile = {
  fullName,
  resumeText: source,
  email: "account@example.test",
}
const confirmedNames =
  nameLayout === "compound" || nameLayout === "temporal"
    ? applicationProfileSchema.parse({
        enabled: true,
        confirmedAt: new Date().toISOString(),
        contact: {
          preferredName: "Test Candidate",
          givenName: "Test Middle",
          familyName: "Candidate",
        },
      })
    : undefined
const identityFields =
  nameLayout === "temporal"
    ? '<div><label for="preferredName">Preferred First &amp; Last Name</label><label for="preferredName">Preferred First &amp; Last Name</label><input id="preferredName" name="preferredName" autocomplete="off" required></div><div><label for="firstName">Legal First Name</label><label for="firstName">Legal First Name</label><input id="firstName" name="firstName" autocomplete="off" required></div><div><label for="lastName">Legal Last Name</label><label for="lastName">Legal Last Name</label><input id="lastName" name="lastName" autocomplete="off" required></div><div><label for="pronouns">Preferred Pronouns</label><input id="pronouns" name="pronouns"></div><div><label for="pronunciation">Name Pronunciation</label><input id="pronunciation" name="pronunciation"></div>'
    : nameLayout === "split" || nameLayout === "compound"
      ? '<fieldset><legend>Name</legend><label for="firstName">First name(s)</label><input id="firstName" name="firstName" autocomplete="given-name" required><label for="lastName">Last name (Surname)</label><input id="lastName" name="lastName" autocomplete="family-name" required></fieldset>'
      : `<label for="name">${nameLayout === "full" ? "Please enter your full name" : "Full name"}</label><input id="name" name="name" autocomplete="name" required>`
const expectedNames =
  nameLayout === "temporal"
    ? {
        preferredName: "Test Candidate",
        firstName: "Test Middle",
        lastName: "Candidate",
      }
    : nameLayout === "split" || nameLayout === "compound"
      ? {
          firstName: nameLayout === "compound" ? "Test Middle" : "Test",
          lastName: "Candidate",
        }
      : { name: fullName }
const complex = process.argv.includes("--complex")
const delayedDropdown = process.argv.includes("--delayed-dropdown")
const embedded = process.argv.includes("--embedded")
const humanAssistance = process.argv.includes("--human-assistance")
const verificationWaitMs = Number(
  process.argv
    .find((arg) => arg.startsWith("--verification-wait-ms="))
    ?.split("=")[1] || "0"
)
assert.ok(
  Number.isInteger(verificationWaitMs) &&
    verificationWaitMs >= 0 &&
    verificationWaitMs <= 180_000 &&
    (!verificationWaitMs || humanAssistance),
  "Verification wait must be 0–180000ms and requires --human-assistance"
)
const deterministicFill = process.argv.includes("--deterministic-fill")
const applyButton = process.argv.includes("--apply-button")
const formControls = process.argv.includes("--form-controls")
const planner = applicationFormPlanner(
  process.argv.find((arg) => arg.startsWith("--planner="))?.split("=")[1] ||
    "computer"
)
process.env.APPLICATION_FORM_PLANNER = planner
assert.ok(!(embedded && complex), "Run embedded and complex cases separately")
assert.ok(
  !formControls || (!complex && !embedded && !humanAssistance),
  "Run the guide-style control case separately"
)
assert.ok(
  !humanAssistance || (!complex && !embedded),
  "Run human assistance as its own generated fixture"
)
if (process.argv.includes("--trace")) {
  const fetcher = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const response = await fetcher(input, init)
    if (String(input).includes("ai-gateway.vercel.sh")) {
      const data = await response.clone().json()
      console.log(
        JSON.stringify({
          syntheticModelActions: data.choices?.[0]?.message?.tool_calls,
        })
      )
    }
    return response
  }
}
const guideQuestions = formControls
  ? `
<fieldset><legend>Work authorization</legend>
<label><input type="radio" name="authorization" value="Yes" required>Yes</label>
<label><input type="radio" name="authorization" value="No" required>No</label></fieldset>
<fieldset><legend>Preferred work modes</legend>
<label><input type="checkbox" name="preferredModes" value="Remote">Remote</label>
<label><input type="checkbox" name="preferredModes" value="Hybrid">Hybrid</label>
<label><input type="checkbox" name="preferredModes" value="On-site">On-site</label></fieldset>
<label for="destination">Destination country</label><select id="destination" name="destination" required>
<option value="">Select a country</option><option value="IN">India</option><option value="DE">Germany</option></select>
<label for="experience">Relevant experience</label><textarea id="experience" name="experience" required></textarea>
`
  : ""
const html = `<!doctype html><html><head><style>body{font:16px system-ui;max-width:750px;margin:30px auto}label{display:block;margin:14px 0 4px}input,button,textarea{font:inherit;padding:8px}button{margin:14px 4px 0 0}[hidden]{display:none!important}[role=option]{display:block}</style></head><body>
<h1>Generated application: Synthetic engineer</h1><p>Fictional QA only. No employer receives data.</p><form onsubmit="event.preventDefault();window.finish()">
<section id="first">${identityFields}<label for="email">Email</label><input id="email" name="email" type="email" required><label for="phone">Phone number</label><input id="phone" name="phone" type="tel" required><label for="linkedin">LinkedIn URL</label><input id="linkedin" name="linkedin" type="url" required><label for="resume">Resume</label><input id="resume" name="resume" type="file" required>
${guideQuestions}
${complex ? `<label>Work mode</label><button id="workMode" type="button" role="combobox" aria-label="Work mode" aria-required="true" aria-controls="modes" aria-expanded="false" onclick="modes.hidden=!modes.hidden;this.setAttribute('aria-expanded',String(!modes.hidden))">Choose a mode</button><div id="modes" role="listbox" hidden><button type="button" role="option" onclick="window.mode('Remote')">Remote</button><button type="button" role="option" onclick="window.mode('On-site')">On-site</button></div><div id="salaryQuestion" hidden><label for="salary">Salary expectation</label><input id="salary" name="salary" type="number"></div><button type="button" onclick="first.hidden=true;second.hidden=false">Continue</button>` : `<label><input id="consent" name="consent" type="checkbox">Optional marketing consent</label><button type="submit">Submit application</button>`}
</section>${complex ? `<section id="second" hidden><h2>Additional information</h2><label for="notes">Additional notes (optional)</label><textarea id="notes" name="notes"></textarea><label><input id="consent" name="consent" type="checkbox">Optional marketing consent</label><button type="submit">Submit application</button></section>` : ""}</form><script>
window.submissions=0;window.mode=function(value){workMode.innerText=value;workMode.setAttribute('aria-valuetext',value);modes.hidden=true;workMode.setAttribute('aria-expanded','false');salaryQuestion.hidden=false;salary.required=true};
window.completeSyntheticVerification=function(){document.body.innerHTML='<h1>Thank you for applying</h1><p>Your application has been received by the generated test form.</p>'};
window.finish=function(){for(const [id,expected] of Object.entries(${JSON.stringify(expectedNames)})){if(document.getElementById(id).value!==expected)throw Error('Wrong name value')}if(document.getElementById('consent').checked)throw Error('Unapproved consent');if(!document.getElementById('resume').files.length)throw Error('Missing resume');${complex ? "if(salary.value!=='73000')throw Error('Wrong explicit answer');" : ""}${formControls ? `const data=new FormData(document.querySelector('form'));if(data.get('authorization')!=='No'||JSON.stringify(data.getAll('preferredModes'))!==JSON.stringify(['Remote','Hybrid'])||data.get('destination')!=='DE'||data.get('experience')!=='Built TypeScript APIs and SQL services.')throw Error('Wrong approved form values');` : ""}window.submissions++;${humanAssistance ? `document.body.innerHTML='<h1>Generated manual verification step</h1><p>This is a synthetic test, not a CAPTCHA.</p><iframe src="about:blank#challenge" title="Generated verification"></iframe><button type="button" onclick="window.completeSyntheticVerification()">Complete synthetic verification</button>'` : "window.completeSyntheticVerification()"}};</script></body></html>`
const dropdownHtml = delayedDropdown
  ? html.replace(
      "modes.hidden=!modes.hidden;this.setAttribute",
      "setTimeout(()=>{modes.hidden=false},900);this.setAttribute"
    )
  : html
const nameHtml =
  nameLayout === "temporal"
    ? dropdownHtml.replace(
        '<label for="linkedin">LinkedIn URL</label><input id="linkedin" name="linkedin" type="url" required>',
        '<div><label for="linkedin">LinkedIn Profile</label><label for="linkedin">LinkedIn Profile</label><input id="linkedin" name="linkedin" type="text" autocomplete="off" required></div>'
      )
    : dropdownHtml
const applicationHtml = applyButton
  ? nameHtml.replaceAll(
      'type="submit">Submit application',
      'type="button" onclick="this.form.requestSubmit()">Apply'
    )
  : nameHtml
let calls = 0
let totalCalls = 0
const reserve = async () => {
  totalCalls++
  if (++calls > 32)
    throw new Error("Synthetic verification decision budget reached")
}
const receipt = {
  planner,
  fixtureHash: createHash("sha256").update(applicationHtml).digest("hex"),
  provider: process.argv.includes("--local") ? "local-chrome" : "browserbase",
  model:
    planner === "browser-use"
      ? process.env.TAILORING_MODEL
      : process.env.APPLICATION_COMPUTER_MODEL,
  receiptModel:
    process.env.APPLICATION_RECEIPT_MODEL ||
    process.env.APPLICATION_COMPUTER_MODEL,
  syntheticOnly: true,
  employerSubmissions: 0,
  complex,
  delayedDropdown,
  embedded,
  humanAssistance,
  deterministicFill,
  applyButton,
  formControls,
  nameLayout,
}
async function verify(browser: import("playwright-core").Browser) {
  const context = browser.contexts()[0] || (await browser.newContext())
  // Fixture HTML has no network resources. Block all network actions in the browser.
  await context.route("**/*", (route) =>
    route.request().url() === "https://application-fixture.invalid/"
      ? route.fulfill({
          status: 200,
          contentType: "text/html",
          body: applicationHtml,
        })
      : route.abort()
  )
  let page = context.pages()[0] || (await context.newPage())
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto("https://application-fixture.invalid/")
  let surface:
    | import("playwright-core").Page
    | import("playwright-core").Frame = page
  if (embedded) {
    await page.setContent(
      '<iframe title="Generated embedded application" srcdoc="<body></body>" style="width:100%;height:880px;border:0"></iframe>'
    )
    surface = page.frames().find((frame) => frame.parentFrame())!
    assert.ok(surface)
    await surface.setContent(applicationHtml)
    await surface.evaluate(
      `const form=document.querySelector('form');const host=document.createElement('div');document.body.append(host);host.attachShadow({mode:'open'}).append(form);window.finish=function(){const root=host.shadowRoot;if(root.querySelector('#consent').checked)throw Error('Unapproved consent');if(!root.querySelector('#resume').files.length)throw Error('Missing resume');window.submissions++;document.body.innerHTML='<h1>Thank you for applying</h1><p>Your application has been received by the generated test form.</p>'}`
    )
  }
  const job = { title: "Synthetic engineer", company: "Generated application" }
  const form = await discoverComputerForm(
    page,
    job,
    reserve,
    Infinity,
    true,
    planner
  )
  if (nameLayout === "temporal")
    for (const label of [
      "Preferred First & Last Name",
      "Legal First Name",
      "Legal Last Name",
      "LinkedIn Profile",
    ])
      assert.equal(
        form.fields.filter((field) => field.label === label).length,
        1,
        "Duplicate DOM labels must resolve to one question"
      )
  console.log(
    JSON.stringify({
      discovered: form.fields.map((f) => ({
        id: f.id,
        label: f.label,
        kind: f.kind,
        required: f.required,
      })),
      calls,
    })
  )
  let packet: ApplicationPacket = {
    ...job,
    ...form,
    resume: source,
    answers: profileAnswers(form.fields, profile, profile.email),
    formHash: formHash(form.fields, form.notices),
    tailored: true,
    engine: "computer-v1",
  }
  packet = fillApplicationProfile(packet, confirmedNames, "Germany")
  if (complex) {
    const field = packet.fields.find((f) => /work mode/i.test(f.label))
    assert.ok(field)
    packet.answers[field.id] = "Remote"
  }
  if (formControls) {
    const approved = [
      { label: "Work authorization", kind: "radio", value: "No" },
      {
        label: "Preferred work modes",
        kind: "checkbox",
        value: ["Remote", "Hybrid"],
      },
      { label: "Destination country", kind: "select", value: "Germany" },
      {
        label: "Relevant experience",
        kind: "textarea",
        value: "Built TypeScript APIs and SQL services.",
      },
    ]
    for (const answer of approved) {
      const fields = packet.fields.filter(
        (field) => field.label === answer.label
      )
      assert.equal(
        fields.length,
        1,
        "The guide-style questions must have one mapping each"
      )
      assert.equal(fields[0].kind, answer.kind)
      packet.answers[fields[0].id] = answer.value
    }
  }
  let submissions = 0
  let handoffs = 0
  const humanVerification = async (ready: () => Promise<boolean>) => {
    assert.equal(humanAssistance, true)
    assert.equal(await surface.evaluate("window.submissions"), 1)
    assert.equal(await ready(), false)
    handoffs++
    const verificationStarted = Date.now()
    while (Date.now() - verificationStarted < verificationWaitMs) {
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          Math.min(
            30_000,
            verificationWaitMs - (Date.now() - verificationStarted)
          )
        )
      )
      assert.equal(await surface.evaluate("window.submissions"), 1)
      assert.equal(await ready(), false)
      console.info("Synthetic verification browser remains connected", {
        waitedMs: Date.now() - verificationStarted,
      })
    }
    // A test-only button simulates the user's intervention. No real CAPTCHA or
    // employer page is accessed; the application agent cannot click this button.
    await surface
      .getByRole("button", {
        name: "Complete synthetic verification",
        exact: true,
      })
      .click()
    assert.equal(await ready(), true)
  }
  const beforeSubmit = async (
    current: ApplicationPacket,
    confirm: () => Promise<{ text: string }>
  ) => {
    for (const [id, expected] of Object.entries(expectedNames))
      assert.equal(await surface.locator(`#${id}`).inputValue(), expected)
    if (nameLayout === "temporal") {
      assert.equal(await surface.locator("#pronouns").inputValue(), "")
      assert.equal(await surface.locator("#pronunciation").inputValue(), "")
    }
    assert.equal(
      await surface.locator("#email").inputValue(),
      "synthetic@example.test"
    )
    assert.equal(
      await surface.locator("#phone").inputValue(),
      "+91 98765 43210"
    )
    assert.equal(
      await surface.locator("#linkedin").inputValue(),
      "https://linkedin.com/in/synthetic-computer-candidate"
    )
    assert.equal(await surface.locator("#consent").isChecked(), false)
    if (formControls) {
      assert.equal(
        await surface
          .locator('input[name="authorization"][value="No"]')
          .isChecked(),
        true
      )
      assert.equal(
        await surface
          .locator('input[name="authorization"][value="Yes"]')
          .isChecked(),
        false
      )
      for (const mode of ["Remote", "Hybrid", "On-site"])
        assert.equal(
          await surface
            .locator(`input[name="preferredModes"][value="${mode}"]`)
            .isChecked(),
          mode !== "On-site"
        )
      assert.equal(await surface.locator("#destination").inputValue(), "DE")
      assert.equal(
        await surface.locator("#experience").inputValue(),
        "Built TypeScript APIs and SQL services."
      )
    }
    assert.match(
      (await confirm()).text,
      /Thank you for applying|Your application has been received by the generated test form/
    )
    submissions++
  }
  const finish = async (
    result: Awaited<ReturnType<typeof runComputerApplication>>
  ) => {
    assert.equal(result.needsAnswers, false)
    assert.equal(submissions, 1)
    assert.equal(await surface.evaluate("window.submissions"), 1)
    assert.equal(handoffs, humanAssistance ? 1 : 0)
    Object.assign(receipt, {
      passed: true,
      modelCallsInFinalRevision: calls,
      fields: result.packet.fields.length,
      optionalConsentUntouched: true,
      nameValuesVerified: true,
      syntheticSubmissions: submissions,
      handoffs,
      verificationWaitMs,
      ...(formControls ? { guideControlsVerified: true } : {}),
      checkedAt: new Date().toISOString(),
    })
  }
  const result = await runComputerApplication(page, packet, {
    planner,
    deterministicFill,
    reuseApprovedMapping: !process.argv.includes("--no-reuse-mapping"),
    automatic: true,
    savedAnswers: async (latest) =>
      fillApplicationIdentity(
        fillApplicationProfile(latest, confirmedNames, "Germany"),
        profile
      ),
    reserveDecision: reserve,
    beforeSubmit,
    humanVerification,
  })
  if (complex) {
    assert.equal(result.needsAnswers, true)
    assert.equal(submissions, 0)
    const salary = result.packet.fields.find((f) => /salary/i.test(f.label))
    assert.ok(salary)
    assert.equal(
      result.packet.answers[salary.id],
      undefined,
      "Salary must not be invented"
    )
    packet = {
      ...result.packet,
      answers: { ...result.packet.answers, [salary.id]: "73000" },
    }
    return async (freshBrowser: import("playwright-core").Browser) => {
      const replay =
        freshBrowser.contexts()[0] || (await freshBrowser.newContext())
      await replay.route("**/*", (route) =>
        route.request().url() === "https://application-fixture.invalid/"
          ? route.fulfill({
              status: 200,
              contentType: "text/html",
              body: applicationHtml,
            })
          : route.abort()
      )
      page = replay.pages()[0] || (await replay.newPage())
      surface = page
      await page.goto("https://application-fixture.invalid/")
      calls = 0 // a human-reviewed continuation starts a new revision budget
      const continued = await runComputerApplication(page, packet, {
        planner,
        deterministicFill,
        reuseApprovedMapping: !process.argv.includes("--no-reuse-mapping"),
        automatic: true,
        savedAnswers: async (latest) =>
          fillApplicationIdentity(latest, profile),
        reserveDecision: reserve,
        beforeSubmit,
      })
      await finish(continued)
    }
  }
  await finish(result)
}
const started = Date.now()
try {
  if (process.argv.includes("--native-local")) {
    const withLocal = async <T,>(
      run: (browser: import("playwright-core").Browser) => Promise<T>
    ) => {
      const reservation = createServer()
      await new Promise<void>((resolve) =>
        reservation.listen(0, "127.0.0.1", resolve)
      )
      const address = reservation.address()
      assert.ok(address && typeof address === "object")
      const port = address.port
      await new Promise<void>((resolve, reject) =>
        reservation.close((error) => (error ? reject(error) : resolve()))
      )
      const remote = await chromium.launch({
        executablePath:
          process.env.APPLICATION_TEST_CHROME_PATH ||
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        args: [`--remote-debugging-port=${port}`],
        headless: true,
      })
      let browser: import("playwright-core").Browser | undefined
      let unbind: (() => void) | undefined
      try {
        browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
        unbind = bindBrowserUse(
          browser.contexts()[0],
          browserUseRunner(`http://127.0.0.1:${port}`)
        )
        return await run(browser)
      } finally {
        unbind?.()
        await Promise.allSettled([browser?.close(), remote.close()])
      }
    }
    const replay = await withLocal(verify)
    if (replay) await withLocal(replay)
  } else if (process.argv.includes("--local")) {
    const browser = await chromium.launch({
      executablePath:
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      headless: true,
    })
    try {
      const replay = await verify(browser)
      if (replay) await replay(browser)
    } finally {
      await browser.close()
    }
  } else {
    const replay = await withBrowserSession(async (browser, id) => {
      Object.assign(receipt, { sessionId: id })
      return await verify(browser)
    })
    if (replay)
      await withBrowserSession(async (browser, id) => {
        Object.assign(receipt, { continuationSessionId: id })
        await replay(browser)
      })
  }
} catch (error) {
  const failure = applicationFailure(error)
  Object.assign(receipt, {
    passed: false,
    errorCode: failure.code,
    error: failure.message,
    providerStatus:
      error && typeof error === "object" && "status" in error
        ? error.status
        : null,
  })
  process.exitCode = 1
}
Object.assign(receipt, {
  elapsedMs: Date.now() - started,
  totalDecisionReservations: totalCalls,
})
const output = process.argv
  .find((arg) => arg.startsWith("--output="))
  ?.slice("--output=".length)
await writeFile(
  output ||
    `.local-data/computer-agent-verification-${planner}${humanAssistance ? "-human-assistance" : complex ? "-complex" : embedded ? "-embedded" : formControls ? "-form-controls" : ""}.json`,
  JSON.stringify(receipt, null, 2),
  { mode: 0o600 }
)
console.log(JSON.stringify(receipt))
