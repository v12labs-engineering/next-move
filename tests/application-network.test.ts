import assert from "node:assert/strict"
import { once } from "node:events"
import { createServer } from "node:http"
import test from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { chromium } from "playwright-core"
import { publicApplicationUrl } from "../lib/applications/url"
import {
  applicationTarget,
  applicationUnavailableReason,
} from "../lib/applications"
import {
  isPublicAddress,
  publicRequestGuard,
  browserRequestGuard,
  guardApplicationRequests,
} from "../lib/server/applications/network"

test("any public employer domain can expose the same application action", () => {
  for (const url of [
    "https://careers.example.com/vacancies/123?job=backend#apply",
    "https://example.wd5.myworkdayjobs.com/en-US/Careers/job/Engineer_R123",
    "https://recruitment.example.org/candidate/start?id=job-123",
    "https://jobs.example.net/roles/engineer",
  ]) {
    assert.equal(publicApplicationUrl(url), url)
    assert.equal(applicationTarget(url), url)
    assert.equal(applicationUnavailableReason({ url }), null)
  }
})

test("unsafe authorities, private hosts and credential-bearing URLs are rejected before browsing", () => {
  for (const url of [
    "http://careers.example.com/job",
    "https://127.0.0.1/job",
    "https://[::1]/job",
    "https://2130706433/job",
    "https://localhost/job",
    "https://metadata.google.internal/latest",
    "https://company.local/job",
    "https://user:pass@careers.example.com/job",
    "https://careers.example.com:8443/job",
    "file:///etc/passwd",
    "https://careers.example.com\\@127.0.0.1/job",
    "https://careers.example.com/ bad",
  ])
    assert.equal(publicApplicationUrl(url), null, url)
})

test("public-address checks reject private, loopback, mapped and reserved IPv4/IPv6", () => {
  for (const address of [
    "127.0.0.1",
    "0.0.0.0",
    "10.0.0.1",
    "172.16.1.1",
    "192.168.0.1",
    "169.254.169.254",
    "100.64.0.1",
    "198.18.0.1",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "::",
    "fc00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "2001:db8::1",
  ])
    assert.equal(isPublicAddress(address), false, address)
  assert.equal(isPublicAddress("8.8.8.8"), true)
  assert.equal(isPublicAddress("2606:4700:4700::1111"), true)
})

test("redirects and subresources use the same DNS guard, with no vendor allowlist", async () => {
  const guard = publicRequestGuard(async (host) =>
    host === "private.example.com"
      ? ["10.0.0.2"]
      : host === "mixed.example.com"
        ? ["8.8.8.8", "127.0.0.1"]
        : ["8.8.8.8"]
  )
  await guard("https://careers.example.com/job")
  await guard("https://hiring.anothercompany.com/application/123")
  await assert.rejects(guard("https://private.example.com/metadata"), /public/)
  await assert.rejects(guard("https://mixed.example.com/script.js"), /public/)
  await assert.rejects(guard("https://169.254.169.254/latest"), /public/)
  const unavailable = publicRequestGuard(async () => {
    throw Error("DNS failure")
  })
  await assert.rejects(
    unavailable("https://careers.example.com/job"),
    /DNS failure/
  )
})

test("a host is resolved again on later requests instead of trusting an earlier public answer", async () => {
  let lookups = 0
  const guard = publicRequestGuard(async () =>
    ++lookups === 1 ? ["8.8.8.8"] : ["127.0.0.1"]
  )
  await guard("https://careers.example.com/job")
  await assert.rejects(guard("https://careers.example.com/next"), /public/)
  assert.equal(lookups, 2)
})

test("Chromium interception validates redirect hops before allowing them onto the network", async () => {
  const commands: { method: string; params: unknown }[] = []
  let paused: (event: {
    requestId: string
    request: { url: string }
    resourceType: string
    redirectedRequestId?: string
  }) => Promise<void>
  const session = {
    on: (_event: string, handler: typeof paused) => {
      paused = handler
    },
    send: async (method: string, params: unknown) => {
      commands.push({ method, params })
    },
  }
  const frame = { parentFrame: () => null, page: () => page }
  const page = { mainFrame: () => frame }
  const context = { newCDPSession: async () => session }
  const guard = publicRequestGuard(async () => ["8.8.8.8"])
  await browserRequestGuard(context as never, page as never, guard)
  assert.equal(
    commands.some((c) => c.method === "Network.setBypassServiceWorker"),
    true
  )
  assert.equal(
    commands.some((c) => c.method === "Fetch.enable"),
    true
  )
  await paused!({
    requestId: "first",
    request: { url: "https://careers.example.com/job/1" },
    resourceType: "Document",
  })
  await paused!({
    requestId: "second",
    redirectedRequestId: "first",
    request: { url: "https://hiring.example.org/application/1" },
    resourceType: "Document",
  })
  await paused!({
    requestId: "private",
    redirectedRequestId: "second",
    request: { url: "https://169.254.169.254/latest" },
    resourceType: "Document",
  })
  assert.deepEqual(
    commands
      .filter((c) => c.method === "Fetch.continueRequest")
      .map((c) => c.params),
    [{ requestId: "first" }, { requestId: "second" }]
  )
  assert.deepEqual(
    commands
      .filter((c) => c.method === "Fetch.failRequest")
      .map((c) => c.params),
    [{ requestId: "private", errorReason: "BlockedByClient" }]
  )
})

test("Apply opens a guarded form in a new tab without a failed navigation", async () => {
  const visits: string[] = []
  const fixture = createServer((request, response) => {
    const path = request.url ?? ""
    visits.push(path)
    if (path === "/apply" || path === "/restricted-apply") {
      response.writeHead(302, {
        Location: path === "/apply" ? "/form" : "/restricted",
      })
      return response.end()
    }
    response.setHeader("Content-Type", "text/html")
    response.end('<form><label>Name <input name="name"></label></form>')
  })
  fixture.listen(0, "127.0.0.1")
  try {
    await once(fixture, "listening")
    const address = fixture.address()
    assert.ok(address && typeof address !== "string")
    const origin = `http://127.0.0.1:${address.port}`
    const browser = await chromium.launch({
      ...(process.env.CHROME_EXECUTABLE_PATH
        ? { executablePath: process.env.CHROME_EXECUTABLE_PATH }
        : { channel: "chrome" }),
    })
    try {
      const context = await browser.newContext()
      const page = await context.newPage()
      const failed: string[] = []
      const blocked = Promise.withResolvers<boolean>()
      context.on("requestfailed", (request) => failed.push(request.url()))
      await guardApplicationRequests(context, page, async (url) => {
        const destination = new URL(url)
        assert.equal(destination.origin, origin)
        if (destination.pathname === "/restricted") blocked.resolve(true)
        assert.notEqual(destination.pathname, "/restricted")
      })
      await page.setContent(
        `<a target="_blank" href="${origin}/apply">Apply now</a>
         <a target="_blank" href="${origin}/restricted-apply">Restricted destination</a>`
      )
      const [application] = await Promise.all([
        page.waitForEvent("popup"),
        page.getByRole("link", { name: "Apply now" }).click(),
      ])
      await application.getByLabel("Name").fill("Synthetic Candidate", {
        timeout: 3000,
      })
      assert.equal(
        await application.getByLabel("Name").inputValue(),
        "Synthetic Candidate"
      )
      assert.equal(failed.includes(`${origin}/apply`), false)
      await page.getByRole("link", { name: "Restricted destination" }).click()
      assert.equal(
        await Promise.race([
          blocked.promise,
          delay(3000, false, { ref: false }),
        ]),
        true
      )
      assert.equal(visits.filter((path) => path === "/apply").length, 1)
      assert.equal(visits.filter((path) => path === "/form").length, 1)
      assert.equal(visits.includes("/restricted"), false)
    } finally {
      await browser.close()
    }
  } finally {
    fixture.close()
    await once(fixture, "close")
  }
})
