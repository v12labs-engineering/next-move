// Real SDK/model and production native-agent path, fictional data, local receiver.
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdir, readFile, writeFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { parseEnv } from "node:util"
import { chromium } from "playwright-core"
import { getVercelOidcToken } from "@vercel/oidc"
import {
  bindBrowserUse,
  browserUseRunner,
} from "../../lib/server/applications/browser-use"
import { runNativeApplication } from "../../lib/server/applications/native-agent"
import type { ApplicationPacket } from "../../lib/applications"

const env = parseEnv(await readFile(".env.staging.local", "utf8"))
for (const key of [
  "TAILORING_BASE_URL",
  "TAILORING_MODEL",
  "TAILORING_API_KEY",
  "BROWSER_USE_MODEL",
])
  if (env[key] && !process.env[key]) process.env[key] = env[key]
process.env.BROWSER_USE_PYTHON ||= join(
  process.cwd(),
  ".local-data/browser-use-venv/bin/python"
)
delete process.env.BROWSER_USE_WORKER_URL
process.env.VERCEL_OIDC_TOKEN = await getVercelOidcToken({
  project: "prj_y2XdyM0PSbTvcLIT70cX9pKTz6CE",
  team: "team_xP5ofTY8NOOv2tFfvu6RJrBL",
})
const fields: ApplicationPacket["fields"] = [
  { id: "name", label: "Full name", kind: "text", required: true },
  { id: "email", label: "Email", kind: "email", required: true },
  { id: "phone", label: "Phone", kind: "tel", required: true },
  {
    id: "country",
    label: "Country",
    kind: "select",
    required: true,
    options: ["India", "Germany"],
  },
  {
    id: "experience",
    label: "Relevant experience",
    kind: "textarea",
    required: true,
  },
  { id: "resume", label: "Resume", kind: "resume", required: true },
].map((f) => ({ help: "", options: [], ...f })) as ApplicationPacket["fields"]
const packet: ApplicationPacket = {
  title: "Synthetic Engineer",
  company: "Local Test Receiver",
  fields,
  answers: {
    name: "Test Candidate",
    email: "synthetic@example.test",
    phone: "+919876543210",
    country: "Germany",
    experience: "Built TypeScript APIs and SQL services.",
  },
  resume:
    "Test Candidate\nsynthetic@example.test\nBuilt TypeScript APIs and SQL services.",
  notices: "",
  formHash: "synthetic",
  tailored: true,
}
const html = `<!doctype html><title>Synthetic application</title><style>label{display:block;margin:22px 0}input,select,textarea{display:block}body{font:18px sans-serif;padding:20px}</style>
<h1>Synthetic Engineer — Local Test Receiver</h1><form id="application">
<label>Full name<input id="name" required></label><label>Email<input id="email" type="email" required></label><label>Phone<input id="phone" type="tel" required></label>
<label>Country<select id="country" required><option value="">Choose</option><option>India</option><option>Germany</option></select></label>
<label>Relevant experience<textarea id="experience" required></textarea></label><label>Resume<input id="resume" type="file" required></label>
<label><input id="consent" type="checkbox">Optional marketing consent</label><button type="submit">Submit application</button></form>
<script>window.order=[];window.submissions=0;document.addEventListener('input',e=>{if(e.target.id&&!window.order.includes(e.target.id))window.order.push(e.target.id)});document.addEventListener('change',e=>{if(e.target.id&&!window.order.includes(e.target.id))window.order.push(e.target.id)});document.querySelector('form').onsubmit=e=>{e.preventDefault();window.submissions++;document.body.innerHTML='<h1>Thank you for applying. Your application has been received.</h1>'}</script>`
const server = createServer((_req, res) => {
  res.setHeader("Content-Type", "text/html")
  res.end(html)
})
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
const address = server.address()
assert.ok(address && typeof address === "object")
const portServer = createServer()
await new Promise<void>((resolve) => portServer.listen(0, "127.0.0.1", resolve))
const portAddress = portServer.address()
assert.ok(portAddress && typeof portAddress === "object")
await new Promise<void>((resolve) => portServer.close(() => resolve()))
const remote = await chromium.launch({
  executablePath:
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
  args: [`--remote-debugging-port=${portAddress.port}`],
})
const browser = await chromium.connectOverCDP(
  `http://127.0.0.1:${portAddress.port}`
)
const page = await browser.contexts()[0].newPage()
const unbind = bindBrowserUse(
  page.context(),
  browserUseRunner(`http://127.0.0.1:${portAddress.port}`)
)
const uploads: string[] = []
const fetchOriginal = globalThis.fetch
// Emulate only Browserbase's document staging; native upload reads the same bytes.
globalThis.fetch = async (input, init) => {
  if (
    String(input) ===
    "https://api.browserbase.com/v1/sessions/synthetic/uploads"
  ) {
    const form = await new Request(String(input), init).formData()
    const file = form.get("file")
    assert.ok(file instanceof File)
    assert.equal(file.name, file.name.split("/").pop())
    await mkdir("/tmp/.uploads", { recursive: true })
    const path = join("/tmp/.uploads", file.name)
    await writeFile(path, Buffer.from(await file.arrayBuffer()), { flag: "wx" })
    uploads.push(path)
    return Response.json({ message: "File uploaded successfully" })
  }
  return fetchOriginal(input, init)
}
process.env.BROWSERBASE_API_KEY = "synthetic-not-a-real-key"
const info = console.info
const events: Record<string, unknown>[] = []
console.info = (label, data) => {
  events.push({ label, ...data })
  info(label, data)
}
let turns = 0,
  intent = false,
  receipt = false
const started = performance.now()
const agentic = process.argv.includes("--agentic")
try {
  await page.goto(`http://127.0.0.1:${address.port}`)
  const result = await runNativeApplication(
    page,
    agentic
      ? { ...packet, engine: "browser-use", fields: [], answers: {} }
      : packet,
    {
      sessionId: "synthetic",
      logContext: { applicationId: "synthetic", revision: 1 },
      reserveDecision: async () => {
        assert.ok(++turns <= 60)
      },
      savedAnswers: async () =>
        agentic
          ? {
              savedAnswers: fields
                .filter((field) => field.kind !== "resume")
                .map((field) => ({
                  question: field.label,
                  answer: packet.answers[field.id],
                })),
              resume: packet.resume,
            }
          : {},
      beginSubmission: async () => {
        assert.equal(intent, false)
        for (const [id, answer] of Object.entries(packet.answers))
          assert.equal(await page.locator(`#${id}`).inputValue(), answer)
        assert.equal(await page.locator("#consent").isChecked(), false)
        assert.equal(
          await page
            .locator("#resume")
            .evaluate((el: HTMLInputElement) => el.files?.length),
          1
        )
        assert.deepEqual(await page.evaluate("window.order"), [
          "name",
          "email",
          "phone",
          "country",
          "experience",
          "resume",
        ])
        assert.equal(await page.evaluate("window.submissions"), 0)
        intent = true
      },
      recordReceipt: async () => {
        assert.equal(intent, true)
        assert.equal(await page.evaluate("window.submissions"), 1)
        receipt = true
      },
    }
  )
  assert.equal(result.needsAnswers, false)
  assert.equal(receipt, true)
  const inspections = events.filter(
    (e) => Array.isArray(e.actions) && e.actions.includes("evaluate")
  ).length
  assert.ok(
    inspections <= 1,
    `Expected at most one consolidated inspection, got ${inspections}`
  )
  for (const phase of [
    "sdk_import",
    "browser_connect",
    "dom_snapshot",
    "model",
    "first_input",
    "reserve_database",
    "native_action",
    "worker_total",
  ])
    assert.ok(
      events.some((e) => e.phase === phase),
      `Missing timing: ${phase}`
    )
  const report = {
    passed: true,
    agentic,
    turns,
    inspections,
    topToBottom: true,
    singleSubmission: true,
    durationMs: Math.round(performance.now() - started),
    firstInputMs: events.find((e) => e.phase === "first_input")?.durationMs,
  }
  console.log(JSON.stringify(report))
  await writeFile(
    ".local-data/native-agent-verification.json",
    JSON.stringify(report, null, 2)
  )
} finally {
  console.info = info
  globalThis.fetch = fetchOriginal
  unbind()
  await Promise.allSettled([
    browser.close(),
    remote.close(),
    ...uploads.map((path) => rm(path)),
  ])
  server.close()
}
