import assert from "node:assert/strict"
import test from "node:test"
import type { Frame, Page } from "playwright-core"
import { ComputerBrowser } from "../lib/server/applications/computer-browser"

function fixture() {
  const states: {
    visible: boolean
    detached: boolean
    notices: string
    controls: object[]
  }[] = []
  const frames: Frame[] = []
  const append = (
    notices = "",
    controls: object[] = [],
    visible = true,
    parent: Frame | null = frames[0] ?? null
  ) => {
    const state = { visible, detached: false, notices, controls }
    const frame = {
      parentFrame: () => parent,
      isDetached: () => state.detached,
      frameElement: async () => ({
        isVisible: async () => state.visible,
        dispose: async () => {},
      }),
      evaluate: async () => ({
        title: "Generated employer",
        text: state.notices,
        notices: state.notices,
        controls: state.controls,
      }),
    } as unknown as Frame
    states.push(state)
    frames.push(frame)
    return state
  }
  const question = {
    selector: "#email",
    tag: "input",
    type: "email",
    label: "Email",
    required: true,
    disabled: false,
  }
  append("Employer instructions", [question])
  const page = {
    frames: () => frames.filter((_, index) => !states[index].detached),
    locator: () => ({ count: async () => 0 }),
    screenshot: async () => Buffer.from("generated screenshot"),
  } as unknown as Page
  return {
    browser: new ComputerBrowser(page),
    append,
    frames,
    states,
    question,
  }
}

test("unchanged visible text-only frames retain their notices during the final check", async () => {
  const f = fixture()
  f.append("Employer information")
  await f.browser.observe()
  assert.equal((await f.browser.assertUnchanged()).length, 1)
})

for (const change of [
  "new",
  "detached",
  "reordered",
  "shown",
  "hidden",
] as const) {
  test(`the final check rejects a ${change} employer frame`, async () => {
    const f = fixture()
    const child = f.append("", [], change !== "shown")
    await f.browser.observe()
    if (change === "new")
      f.append("New required question", [{ ...f.question, selector: "#new" }])
    if (change === "detached") child.detached = true
    if (change === "reordered") {
      f.frames.reverse()
      f.states.reverse()
    }
    if (change === "shown") child.visible = true
    if (change === "hidden") child.visible = false
    await assert.rejects(
      f.browser.assertUnchanged(),
      /frame changed|form changed/i
    )
  })
}

test("visible frames beyond the observation bound cannot be silently omitted", async () => {
  const f = fixture()
  for (let index = 0; index < 12; index++) f.append("Additional employer frame")
  await assert.rejects(f.browser.observe(), /Unsupported employer.*frames/i)
})

test("hidden frames do not consume the visible observation bound", async () => {
  const f = fixture()
  for (let index = 0; index < 12; index++)
    f.append("Hidden analytics", [], false)
  f.append("Visible employer question", [{ ...f.question, selector: "#later" }])
  const observed = await f.browser.observe()
  assert.equal(observed.controls.length, 2)
  assert.equal((await f.browser.assertUnchanged()).length, 2)
})

test("a nested frame under a hidden ancestor is not treated as visible", async () => {
  const f = fixture()
  const outer = f.append("Hidden parent", [], false)
  f.append("Nested employer question", [f.question], true, f.frames[1])
  assert.equal((await f.browser.observe()).controls.length, 1)
  outer.visible = true
  await assert.rejects(f.browser.assertUnchanged(), /form changed/i)
})

test("a combobox option uses its observed frame when a hidden frame precedes it", async () => {
  const f = fixture()
  f.append("Hidden analytics", [], false)
  const dropdown = {
    ...f.question,
    selector: "#location",
    role: "combobox",
    label: "Location",
  }
  f.append("Location", [dropdown])
  const rawHidden = f.frames[1] as unknown as { getByRole: () => never }
  rawHidden.getByRole = () =>
    assert.fail("Never use the raw frame index for a compacted observation")
  const option = { count: async () => 1 }
  const form = f.frames[2] as unknown as {
    locator: (selector: string) => {
      count: () => Promise<number>
      evaluate: () => Promise<string[]>
      getByRole: (
        role: string,
        args: { name: string; exact: boolean }
      ) => typeof option
    }
    getByRole: (
      role: string,
      args: { name: string; exact: boolean }
    ) => typeof option
  }
  form.locator = (selector) => {
    assert.ok(["#location", "#owned-options"].includes(selector))
    return {
      count: async () => 1,
      evaluate: async () => ["#owned-options"],
      getByRole: (role, args) => {
        assert.equal(selector, "#owned-options")
        assert.equal(role, "option")
        assert.deepEqual(args, { name: "Approved location", exact: true })
        return option
      },
    }
  }
  form.getByRole = () =>
    assert.fail("Never search other dropdowns in the frame")
  const observed = await f.browser.observe()
  const control = observed.controls.find((c) => c.role === "combobox")!
  assert.equal(control.frame, 1)
  assert.equal(
    await f.browser.optionLocator(control, "Approved location"),
    option
  )
})
