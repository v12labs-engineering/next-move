import assert from "node:assert/strict"
import test from "node:test"
import type { Page, Frame } from "playwright-core"
import { employerAccessGate } from "../lib/server/applications/browser"
import { readVerificationView } from "../lib/server/applications/verification-surface"

function fixture(
  kind: "grid" | "checkbox" | "badge" | "checked",
  hidden = false
) {
  const root = { parentFrame: () => null }
  const element = {
    isVisible: async () => !hidden,
    dispose: async () => {},
    boundingBox: async () => ({ width: 300, height: 300 }),
    screenshot: async () =>
      assert.fail("Metadata probe must not capture images"),
  }
  const parent = { parentFrame: () => root, frameElement: async () => element }
  const frame = {
    parentFrame: () => parent,
    frameElement: async () => element,
    url: () =>
      `https://www.google.com/recaptcha/api2/${kind === "grid" ? "bframe" : "anchor"}`,
    locator: (selector: string) => ({
      count: async () =>
        selector.includes("bframe") ? 0 : kind === "badge" ? 0 : 1,
      isVisible: async () => kind !== "badge",
      getAttribute: async () => (kind === "checked" ? "true" : "false"),
    }),
    evaluate: async () => ({
      mode: "challenge",
      targets: [
        { selector: "#tile", kind: "click", label: "Tile", tile: true },
      ],
      signature: "fixture",
      message: "challenge",
    }),
  }
  const page = {
    locator: () => ({ count: async () => 0 }),
    frames: () => [frame],
    mainFrame: () => root,
    screenshot: async () =>
      assert.fail("Metadata probe must not capture images"),
  } as unknown as Page
  return { page, frame: frame as unknown as Frame }
}

test("nested image challenge is detected through frame ancestry", async () => {
  assert.equal(await employerAccessGate(fixture("grid").page), "challenge")
})
test("visible unchecked anchor needs solving; badges, checked and hidden anchors do not", async () => {
  assert.equal(
    await employerAccessGate(fixture("checkbox").page, true),
    "challenge"
  )
  assert.equal(
    await employerAccessGate(fixture("checkbox").page),
    null,
    "An unchecked checkbox must not block opening the form"
  )
  for (const kind of ["badge", "checked"] as const)
    assert.equal(await employerAccessGate(fixture(kind).page), null)
  assert.equal(await employerAccessGate(fixture("grid", true).page), null)
})
test("CAPTCHA metadata inspection honors captureImage=false", async () => {
  const view = await readVerificationView(fixture("grid").page, false, false)
  assert.equal(view.mode, "challenge")
  assert.equal(view.image.length, 0)
})

test("an initializing blank frame does not crash the application or hide a later CAPTCHA", async () => {
  for (const url of [
    "",
    "not a URL",
    "about:blank",
    "about:srcdoc",
    "data:text/html,loading",
  ]) {
    const transient = {
      url: () => url,
      parentFrame: () => null,
      isDetached: () => false,
    } as unknown as Frame
    const { page, frame } = fixture("grid")
    page.frames = () => [transient]
    assert.equal(await employerAccessGate(page), null)
    page.frames = () => [transient, frame]
    assert.equal(await employerAccessGate(page), "challenge")
  }
})

test("real inspection failures in attached CAPTCHA frames still propagate", async () => {
  const { page, frame } = fixture("grid")
  frame.isDetached = () => false
  frame.frameElement = async () => {
    throw new Error("CDP unavailable")
  }
  await assert.rejects(employerAccessGate(page), /CDP unavailable/)
})

for (const phase of ["visibility", "nested challenge"] as const) {
  test(`detached employer frame during ${phase} inspection preserves later access checks`, async () => {
    const { page } = fixture("badge")
    let detached = false
    const transient = {
      url: () => "https://employer.example/embedded",
      parentFrame: () => ({}),
      isDetached: () => detached,
      frameElement: async () => {
        if (phase === "visibility") {
          detached = true
          throw new Error("frame.frameElement: Frame has been detached.")
        }
        return { isVisible: async () => true, dispose: async () => {} }
      },
      locator: () => ({
        count: async () => {
          detached = true
          throw new Error("Frame has been detached.")
        },
      }),
    } as unknown as Frame
    // Use a single parent level, just like an employer iframe in an aggregator.
    transient.parentFrame = () => ({ parentFrame: () => null }) as Frame
    page.frames = () => [transient]
    assert.equal(await employerAccessGate(page), null)
    page.locator = ((selector: string) => ({
      count: async () => (selector.includes("password") ? 1 : 0),
    })) as Page["locator"]
    assert.equal(await employerAccessGate(page), "sign_in")
    const { frame } = fixture("grid")
    page.frames = () => [transient, frame]
    assert.equal(await employerAccessGate(page), "challenge")
  })
}

test("attached employer frame inspection failures are not swallowed", async () => {
  const { page, frame } = fixture("badge")
  frame.url = () => "https://employer.example/embedded"
  frame.isDetached = () => false
  frame.frameElement = async () => {
    throw new Error("CDP unavailable")
  }
  await assert.rejects(employerAccessGate(page), /CDP unavailable/)
})
