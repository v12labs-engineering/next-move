import assert from "node:assert/strict"
import test, { type TestContext } from "node:test"
import { EventEmitter } from "node:events"
import { runInNewContext } from "node:vm"
import { z } from "zod"
import type { Page } from "playwright-core"
import { bindBrowserUse } from "../lib/server/applications/browser-use"
import {
  applicationFormPlanner,
  applicationFieldDescription,
} from "../lib/server/applications/form-planner"
import {
  ComputerBrowser,
  readComputerDocument,
  type ComputerControl,
  withFieldAssistance,
  withAuthenticationAssistance,
} from "../lib/server/applications/computer-browser"
import {
  bindComputerFields,
  approvedFieldDescriptions,
  observedFieldDescriptions,
  groundFieldDescriptions,
  validationProxy,
  mergeComputerFields,
  type ComputerFieldDescription,
} from "../lib/server/applications/computer-fields"
import {
  discoverComputerForm,
  computerToolErrorReason,
  computerDiagnosticCode,
  runComputerApplication,
  SUBMISSION_RESERVE_MS,
} from "../lib/server/applications/computer-agent"
import {
  missingAnswers,
  packetSchema,
  profileAnswers,
  type ApplicationPacket,
} from "../lib/applications"
import {
  applyRememberedAnswers,
  type SavedQuestion,
} from "../lib/applications/questions"
import { HUMAN_VERIFICATION_WAIT_MS } from "../lib/server/applications/browser-assistance"
import { trackBrowserbaseCaptcha } from "../lib/server/applications/captcha"

test("browser document reader runs without server bundler helpers in a fresh page", () => {
  class Document {
    title = "Headway application"
    body = { innerText: "Application details" }
    createTreeWalker() {
      return { nextNode: () => null }
    }
    querySelectorAll() {
      return []
    }
  }
  const result = runInNewContext(`(${readComputerDocument.toString()})()`, {
    Document,
    ShadowRoot: class {},
    NodeFilter: { SHOW_TEXT: 4 },
    document: new Document(),
  })
  assert.equal(result.title, "Headway application")
  assert.equal(result.text, "Application details")
  assert.equal(result.controls.length, 0)
})

test("visible challenge frames are detected before accessing their execution context", async () => {
  const page = {
    locator: () => ({ count: async () => 1 }),
    frames: () => assert.fail("Do not evaluate inaccessible challenge frames"),
    screenshot: () => assert.fail("Do not capture a challenge before handoff"),
  } as unknown as Page
  await assert.rejects(
    new ComputerBrowser(page).observe(),
    /Human verification required/
  )
  await assert.rejects(
    new ComputerBrowser(page).assertUnchanged(),
    /Human verification required/
  )
})

test("invalid tool input gives the next model turn a safe field path without private values", () => {
  const invalid = z
    .object({
      fields: z.array(z.object({ targets: z.array(z.string()).min(1) })),
    })
    .safeParse({ fields: [{ targets: [] }] })
  assert.equal(invalid.success, false)
  if (invalid.success) return
  const wrapped = new Error("Private candidate answers", {
    cause: new Error("Private tool input", { cause: invalid.error }),
  })
  const reason = computerToolErrorReason(wrapped)
  assert.match(reason, /fields.0.targets.*too_small/)
  assert.doesNotMatch(reason, /Private/)
  assert.equal(
    computerToolErrorReason(new Error("Question label is not visible")),
    "Question label is not visible"
  )
  assert.doesNotMatch(
    computerToolErrorReason(new Error("https://private.invalid?secret=token")),
    /token/
  )
})

test("computer diagnostics retain application failures without provider or candidate text", () => {
  assert.equal(
    computerDiagnosticCode(
      new Error("Private candidate answer and signed URL", {
        cause: new Error("Employer field no longer matches approved answer"),
      })
    ),
    "answer_mismatch"
  )
  assert.equal(
    computerDiagnosticCode(
      new Error("Private candidate answer and signed URL")
    ),
    "unclassified"
  )
  assert.equal(
    computerDiagnosticCode(new Error("Employer rejected a field")),
    "invalid_field"
  )
})

const control = (
  overrides: Partial<ComputerControl> = {}
): ComputerControl => ({
  target: "c0",
  frame: 0,
  selector: "#email",
  tag: "input",
  type: "email",
  role: "",
  label: "Email",
  group: "",
  context: "",
  id: "email",
  name: "email",
  required: true,
  disabled: false,
  options: [],
  value: "",
  checked: false,
  valid: true,
  selectedText: "",
  selectionObservable: false,
  href: "",
  scope: "body",
  autocomplete: "email",
  inViewport: true,
  ...overrides,
})
const description = (
  overrides: Partial<ComputerFieldDescription> = {}
): ComputerFieldDescription => ({
  targets: ["c0"],
  label: "Email",
  kind: "email",
  required: true,
  options: [],
  ...overrides,
})

const nativePlan = (fields = [description()]) => ({
  fields,
  expandTarget: null,
  entryTarget: null,
})
function observation(controls: ComputerControl[]) {
  const browser = new ComputerBrowser({} as Page)
  browser.observation = {
    epoch: 1,
    title: "Synthetic employer",
    text: "Email Phone Resume Work authorization Yes No Cover letter Salary expectation I agree",
    notices: "",
    controls,
    image: Buffer.from("image"),
  }
  return browser
}
const packet: ApplicationPacket = {
  title: "Engineer",
  company: "Synthetic employer",
  resume: "Generated fictional candidate resume with TypeScript experience.",
  fields: [
    {
      id: "email",
      label: "Email",
      kind: "email",
      required: true,
      options: [],
      help: "",
    },
  ],
  answers: { email: "candidate@example.test" },
  notices: "",
  formHash: "fixture",
  tailored: true,
}

test("computer field mapping rejects stale/invented targets, omitted required questions and duplicate controls", () => {
  const browser = observation([
    control(),
    control({
      target: "c1",
      id: "phone",
      selector: "#phone",
      type: "tel",
      label: "Phone",
    }),
  ])
  assert.throws(
    () => bindComputerFields(browser, 2, [description()], 0),
    /Stale/
  )
  assert.throws(
    () =>
      bindComputerFields(
        browser,
        1,
        [description({ targets: ["invented"] })],
        0
      ),
    /Unobserved/
  )
  assert.throws(
    () => bindComputerFields(browser, 1, [description()], 0),
    /omitted/
  )
  assert.throws(
    () => bindComputerFields(browser, 1, [description(), description()], 0),
    /twice/
  )
})
test("model cannot downgrade required fields, rename salary to email, or upload a resume as a cover letter", () => {
  const email = bindComputerFields(
    observation([control()]),
    1,
    [description({ required: false })],
    0
  )[0].field
  assert.equal(email.required, true)
  const salary = bindComputerFields(
    observation([
      control({
        type: "text",
        label: "Salary expectation",
        id: "salary",
        autocomplete: "",
      }),
    ]),
    1,
    [description({ kind: "text", label: "Email" })],
    0
  )[0].field
  assert.equal(salary.label, "Salary expectation")
  assert.deepEqual(
    profileAnswers(
      [salary],
      {
        fullName: "Test Candidate",
        resumeText: "Email: candidate@example.test",
      },
      "account@example.test"
    ),
    {}
  )
  const upload = bindComputerFields(
    observation([
      control({ type: "file", label: "Cover letter", id: "cover" }),
    ]),
    1,
    [description({ kind: "resume", label: "Resume" })],
    0
  )[0].field
  assert.equal(upload.kind, "unsupported")
})
test("observed radio groups retain their actual question/options and reject invented options and mixed frames", () => {
  const controls = [
    control({
      type: "radio",
      target: "c0",
      label: "Yes",
      group: "Work authorization",
      name: "authorization",
      id: "yes",
    }),
    control({
      type: "radio",
      target: "c1",
      label: "No",
      group: "Work authorization",
      name: "authorization",
      id: "no",
    }),
  ]
  const field = bindComputerFields(
    observation(controls),
    1,
    [
      description({
        targets: ["c0", "c1"],
        kind: "radio",
        label: "Invented question",
      }),
    ],
    0
  )[0].field
  assert.equal(field.id, "authorization")
  assert.equal(field.label, "Work authorization")
  assert.deepEqual(field.options, ["Yes", "No"])
  assert.throws(
    () =>
      bindComputerFields(
        observation([control({ type: "text" })]),
        1,
        [description({ kind: "combobox", options: ["Invented option"] })],
        0
      ),
    /not observed/
  )
  assert.throws(
    () =>
      bindComputerFields(
        observation([controls[0], { ...controls[1], frame: 1 }]),
        1,
        [description({ targets: ["c0", "c1"], kind: "radio" })],
        0
      ),
    /frames/
  )
})
test("custom dropdown options can be observed alongside the editable combobox without becoming extra questions", () => {
  const browser = observation([
    control({
      type: "button",
      tag: "button",
      role: "combobox",
      label: "Work mode",
      id: "mode",
    }),
    control({
      target: "c1",
      tag: "button",
      type: "button",
      role: "option",
      label: "Remote",
      required: false,
    }),
    control({
      target: "c2",
      tag: "button",
      type: "button",
      role: "option",
      label: "On-site",
      required: false,
    }),
  ])
  browser.observation.text += " Work mode Remote On-site"
  const binding = bindComputerFields(
    browser,
    1,
    [
      description({
        targets: ["c0", "c1", "c2"],
        label: "Work mode",
        kind: "combobox",
        options: ["Remote", "On-site"],
      }),
    ],
    0
  )[0]
  assert.equal(binding.controls.length, 1)
  assert.deepEqual(binding.field.options, ["Remote", "On-site"])
})

test("search-backed dropdowns ignore empty model options and preserve approved answers", () => {
  const browser = observation([
    control({
      type: "text",
      role: "combobox",
      label: "Location",
      id: "location",
      options: [],
    }),
  ])
  const previous = {
    ...packet,
    fields: [
      {
        ...packet.fields[0],
        id: "location",
        label: "Location",
        kind: "combobox" as const,
        options: [],
      },
    ],
    answers: { location: "India" },
  }
  const field = bindComputerFields(
    browser,
    1,
    [
      description({
        label: "Location",
        kind: "combobox",
        options: ["", "   "],
      }),
    ],
    0
  )[0].field
  assert.deepEqual(field.options, [])
  assert.equal(
    mergeComputerFields(previous, [field], "", 0).answers.location,
    "India"
  )
})

test("native combobox role keeps its kind stable when the model describes its text input", () => {
  const browser = observation([
    control({
      type: "text",
      role: "combobox",
      label: "Location",
      id: "location",
    }),
  ])
  const field = bindComputerFields(
    browser,
    1,
    [description({ label: "Location", kind: "text" })],
    0
  )[0].field
  assert.equal(field.kind, "combobox")
})

test("upload widgets bind only the actual file control and cannot turn a cover letter into a resume", () => {
  const browser = observation([
    control({ type: "file", label: "Resume", id: "resume" }),
    control({
      target: "c1",
      tag: "button",
      type: "button",
      label: "Upload File",
      required: false,
    }),
  ])
  const mapped = bindComputerFields(
    browser,
    1,
    [description({ targets: ["c0", "c1"], label: "Resume", kind: "resume" })],
    0
  )[0]
  assert.equal(mapped.controls.length, 1)
  assert.equal(mapped.field.id, "resume")
  browser.observation.controls[0].label = "Cover letter"
  assert.equal(
    bindComputerFields(
      browser,
      1,
      [description({ targets: ["c0", "c1"], kind: "resume" })],
      0
    )[0].field.kind,
    "unsupported"
  )
})

test("a cover letter upload binds as a cover letter only when its label says so", () => {
  const letter = bindComputerFields(
    observation([
      control({ type: "file", label: "Cover letter", id: "cover" }),
    ]),
    1,
    [description({ kind: "cover_letter", label: "Cover letter" })],
    0
  )[0].field
  assert.equal(letter.kind, "cover_letter")
  assert.equal(
    bindComputerFields(
      observation([control({ type: "file", label: "Resume", id: "resume" })]),
      1,
      [description({ kind: "cover_letter", label: "Resume" })],
      0
    )[0].field.kind,
    "unsupported"
  )
  assert.throws(
    () =>
      bindComputerFields(
        observation([
          control({ type: "text", label: "Cover letter", autocomplete: "" }),
        ]),
        1,
        [description({ kind: "cover_letter", label: "Cover letter" })],
        0
      ),
    /must target a file control/
  )
})

test("an upload waits for the employer widget and surfaces its rejection", async () => {
  const uploadBrowser = (contexts: string[]) => {
    let waits = 0
    const browser = new ComputerBrowser({
      waitForTimeout: async () => {
        waits++
      },
    } as unknown as Page)
    Object.assign(browser, {
      frames: [
        {
          isDetached: () => false,
          evaluate: async () => ({
            controls: [
              {
                selector: "#resume",
                context: contexts[Math.min(waits, contexts.length - 1)],
              },
            ],
          }),
        },
      ],
    })
    return { browser, waits: () => waits }
  }
  const file = control({ type: "file", selector: "#resume", label: "Resume" })
  const done = uploadBrowser(["Resume Uploading 40%", "Resume resume.pdf"])
  await done.browser.awaitUpload(file)
  assert.equal(done.waits(), 1)
  await assert.rejects(
    uploadBrowser(["Resume Upload failed: file too large"]).browser.awaitUpload(
      file
    ),
    /Employer rejected the uploaded document/
  )
})

test("an attachment link wrapping a file input binds only the file, without clicking its link", () => {
  const browser = observation([
    control({
      target: "c3",
      tag: "a",
      type: "",
      selector: "form > label > a",
      label: "ATTACH RESUME/CV",
      required: false,
    }),
    control({
      target: "c4",
      type: "file",
      selector: "form > label > a > input",
      label: "Resume/CV",
      id: "resume-upload-input",
    }),
  ])
  const binding = bindComputerFields(
    browser,
    1,
    [description({ targets: ["c3", "c4"], kind: "resume" })],
    0
  )[0]
  assert.deepEqual(
    binding.controls.map((c) => c.target),
    ["c4"]
  )
  assert.equal(binding.field.kind, "resume")
  assert.equal(binding.field.required, true)
  // A similarly named link elsewhere is not evidence of an upload wrapper.
  browser.observation.controls[0].selector = "form > a"
  assert.throws(
    () =>
      bindComputerFields(
        browser,
        1,
        [description({ targets: ["c3", "c4"], kind: "resume" })],
        0
      ),
    /upload/
  )
  // Nor can a wrapper in another frame claim the file control.
  browser.observation.controls[0].selector = "form > label > a"
  browser.observation.controls[0].frame = 1
  assert.throws(
    () =>
      bindComputerFields(
        browser,
        1,
        [description({ targets: ["c3", "c4"], kind: "resume" })],
        0
      ),
    /upload/
  )
})

test("radio choice ordering follows the observed page rather than model target order", () => {
  const browser = observation([
    control({
      type: "radio",
      name: "authorization",
      group: "Work authorization",
      label: "Yes",
    }),
    control({
      target: "c1",
      type: "radio",
      name: "authorization",
      group: "Work authorization",
      label: "No",
    }),
  ])
  const mapped = bindComputerFields(
    browser,
    1,
    [description({ targets: ["c1", "c0"], kind: "radio" })],
    0
  )[0]
  assert.deepEqual(mapped.field.options, ["Yes", "No"])
})

test("approved native radio answers survive a model describing the same question as yes/no", () => {
  const browser = observation([
    control({
      id: "authorization-yes",
      type: "radio",
      name: "authorization",
      group: "Work authorization",
      label: "Yes",
    }),
    control({
      target: "c1",
      id: "authorization-no",
      type: "radio",
      name: "authorization",
      group: "Work authorization",
      label: "No",
    }),
  ])
  const before = bindComputerFields(
    browser,
    1,
    [description({ targets: ["c0", "c1"], kind: "radio" })],
    0
  )[0].field
  const after = bindComputerFields(
    browser,
    1,
    [description({ targets: ["c0", "c1"], kind: "yesno" })],
    0
  )[0].field
  const approved = {
    ...packet,
    fields: [before],
    answers: { [before.id]: "No" },
  }
  const reviewed = mergeComputerFields(approved, [after], "", 0, approved)
  assert.equal(reviewed.answers[after.id], "No")
  assert.equal(after.kind, "radio")
})

test("observed pressed Yes/No buttons retain a saved answer when proposed as radios", () => {
  const browser = observation([
    control({
      target: "c0",
      tag: "button",
      type: "button",
      name: "sharing",
      label: "Yes",
      group: "Work authorization",
      selectionObservable: true,
    }),
    control({
      target: "c1",
      tag: "button",
      type: "button",
      name: "sharing",
      label: "No",
      group: "Work authorization",
      selectionObservable: true,
    }),
  ])
  const fields = (kind: "radio" | "yesno") =>
    bindComputerFields(
      browser,
      1,
      [description({ targets: ["c0", "c1"], kind })],
      0
    )[0].field
  const before = fields("yesno")
  const after = fields("radio")
  assert.equal(after.kind, "yesno")
  assert.deepEqual(after.options, ["Yes", "No"])
  const approved = {
    ...packet,
    fields: [before],
    answers: { [before.id]: "No" },
  }
  assert.equal(
    mergeComputerFields(approved, [after], "", 0, approved).answers[after.id],
    "No"
  )
})

test("approved contact answers survive semantic typing of the same text control", () => {
  const browser = observation([
    control({
      id: "linkedin",
      type: "text",
      label: "LinkedIn Profile",
      group: "LinkedIn Profile",
    }),
  ])
  const fields = (kind: "text" | "url") =>
    bindComputerFields(
      browser,
      1,
      [description({ kind, label: "LinkedIn Profile" })],
      0
    )[0].field
  const before = fields("url")
  const after = fields("text")
  const approved = {
    ...packet,
    fields: [before],
    answers: { [before.id]: "https://www.linkedin.com/in/example" },
  }
  const reviewed = mergeComputerFields(approved, [after], "", 0, approved)
  assert.equal(reviewed.answers[after.id], approved.answers[before.id])
  assert.deepEqual(missingAnswers(reviewed), [])
  for (const changed of [
    { ...after, id: "other-link" },
    { ...after, label: "Referee LinkedIn Profile" },
    { ...after, kind: "number" as const },
  ])
    assert.equal(
      mergeComputerFields(approved, [changed], "", 0, approved).answers[
        changed.id
      ],
      undefined
    )
  const invalid = {
    ...approved,
    fields: [after],
    answers: { [after.id]: "not a URL" },
  }
  assert.equal(
    mergeComputerFields(invalid, [before], "", 0, invalid).answers[before.id],
    undefined
  )
})

test("a phone country dropdown keeps its own label instead of inheriting Phone", () => {
  const browser = observation([
    control({
      id: "country",
      type: "text",
      role: "combobox",
      label: "Country*",
      group: "Phone",
    }),
  ])
  const field = bindComputerFields(
    browser,
    1,
    [description({ kind: "combobox", label: "Phone" })],
    0
  )[0].field
  assert.equal(field.label, "Phone: Country*")
  const stale = {
    ...packet,
    fields: [{ ...field, label: "Phone" }],
    answers: { [field.id]: "+15550102030" },
  }
  const reviewed = mergeComputerFields(stale, [field], "", 0, stale)
  assert.equal(reviewed.answers[field.id], undefined)
  assert.deepEqual(missingAnswers(reviewed), ["Phone: Country*"])
})

test("computer packets preserve existing user edits by question meaning and invalidate changed questions", () => {
  const old = { ...packet, answers: { email: "edited@example.test" } }
  const moved = { ...packet.fields[0], id: "new-email" }
  const migrated = mergeComputerFields(old, [moved], "Employer notice", 0)
  assert.equal(migrated.engine, "computer-v1")
  assert.equal(migrated.answers["new-email"], "edited@example.test")
  assert.equal(migrated.answers.email, undefined)
  const changed = mergeComputerFields(
    migrated,
    [{ ...moved, label: "Referee email" }],
    "Changed notice",
    0
  )
  assert.deepEqual(changed.answers, {})
  assert.equal(packetSchema.parse(migrated).engine, "computer-v1")
})

test("an approved combobox answer survives a fresh closed dropdown without accepting conflicting choices", () => {
  const field = {
    ...packet.fields[0],
    id: "location",
    label: "Location",
    kind: "combobox" as const,
    options: ["Hyderabad, Telangana, India", "Hyderabad, Sindh, Pakistan"],
  }
  const approved = {
    ...packet,
    fields: [field],
    answers: { location: "Hyderabad, Telangana, India" },
  }
  const closed = mergeComputerFields(
    approved,
    [{ ...field, options: [] }],
    "",
    0,
    approved
  )
  assert.equal(closed.answers.location, approved.answers.location)
  const conflicting = mergeComputerFields(
    closed,
    [{ ...field, options: ["Indiana, United States"] }],
    "",
    0,
    approved
  )
  assert.equal(conflicting.answers.location, undefined)
  assert.deepEqual(missingAnswers(conflicting), ["Location"])
})

test("a reviewed conditional answer survives fresh-browser replay until its question is revealed", () => {
  const salary = {
    ...packet.fields[0],
    id: "salary",
    label: "Salary expectation",
    kind: "number" as const,
  }
  const approved = {
    ...packet,
    fields: [...packet.fields, salary],
    answers: { ...packet.answers, salary: "73000" },
  }
  const hidden = mergeComputerFields(approved, packet.fields, "", 0, approved)
  assert.equal(hidden.answers.salary, undefined)
  const revealed = mergeComputerFields(hidden, approved.fields, "", 0, approved)
  assert.equal(revealed.answers.salary, "73000")
  const changed = mergeComputerFields(
    hidden,
    [{ ...salary, label: "Current salary" }],
    "",
    0,
    approved
  )
  assert.equal(changed.answers.salary, undefined)
})

function browserFixture(
  initial = control(),
  searchOption?: string,
  submitOverrides: Partial<ComputerControl> = {}
) {
  let controls = [
    initial,
    control({
      target: "c1",
      tag: "button",
      type: "submit",
      id: "send",
      name: "",
      label: "Submit application",
      selector: "#send",
      required: false,
      ...submitOverrides,
    }),
  ]
  let text = "Email Submit application"
  let notices = ""
  let onUpload: ((name: string) => void) | undefined
  let submissions = 0
  let locatorReads = 0
  let boundary = false
  let fillFailure: (() => void) | undefined
  let selectedDocument = Buffer.from("unapproved existing file")
  let uploads = 0
  let onDocumentRead: (() => void) | undefined
  let challengeOnSubmit = false
  let challengeVisible = false
  let onSubmission: (() => void) | undefined
  const nativeMarkers = new Map<string, string>()
  const frame = {
    parentFrame: () => null,
    isDetached: () => false,
    getByRole: (role: string, options: { name: string; exact: boolean }) => {
      assert.equal(role, "option")
      assert.equal(options.name, searchOption)
      assert.equal(options.exact, true)
      return {
        count: async () => (controls[0].value === searchOption ? 1 : 0),
        isVisible: async () => controls[0].value === searchOption,
        waitFor: async () => assert.equal(controls[0].value, searchOption),
        click: async () => assert.equal(controls[0].value, searchOption),
      }
    },
    evaluate: async (fn: unknown) => {
      assert.equal(fn, readComputerDocument)
      return {
        title: "Synthetic employer",
        notices,
        text,
        controls: controls.map((c) => ({ ...c })),
      }
    },
    locator: (selector: string) => {
      if (!selector.includes("iframe")) locatorReads++
      return {
        getByRole: (
          role: string,
          options: { name: string; exact: boolean }
        ) => {
          assert.equal(selector, "#owned-options")
          return frame.getByRole(role, options)
        },
        elementHandle: async () => ({
          evaluate: async (
            fn: (node: unknown, args: unknown) => unknown,
            args: { attribute: string; marker: string }
          ) =>
            fn(
              {
                setAttribute: () => nativeMarkers.set(args.marker, selector),
                getAttribute: () =>
                  nativeMarkers.has(args.marker) ? args.marker : null,
                removeAttribute: () => nativeMarkers.delete(args.marker),
              },
              args
            ),
          dispose: async () => {},
        }),
        press: async (key: string) => {
          assert.ok(["Escape", "Tab"].includes(key))
        },
        count: async () =>
          selector.includes("iframe") ? Number(challengeVisible) : 1,
        fill: async (value: string) => {
          if (fillFailure) {
            const fail = fillFailure
            fillFailure = undefined
            fail()
          }
          const current = controls.find((c) => c.selector === selector)
          assert.ok(current)
          current.value = value
        },
        setChecked: async (checked: boolean) => {
          const current = controls.find((c) => c.selector === selector)
          assert.ok(current)
          current.checked = checked
        },
        setInputFiles: async (file: { buffer: Buffer; name: string }) => {
          selectedDocument = Buffer.from(file.buffer)
          controls.find((c) => c.selector === selector)!.value =
            "[file selected]"
          uploads++
          onUpload?.(file.name)
        },
        evaluate: async (fn: unknown) => {
          if (String(fn).includes("aria-controls")) return ["#owned-options"]
          if (String(fn).includes("file.arrayBuffer")) {
            onDocumentRead?.()
            return Array.from(selectedDocument)
          }
          return !String(fn).includes("checkValidity")
        },
        click: async () => {
          if (
            controls.find((c) => c.selector === selector)?.role === "combobox"
          )
            return
          assert.equal(
            boundary,
            true,
            "No click before persisted submit intent"
          )
          submissions++
          challengeVisible = challengeOnSubmit
          text = "Thank you for applying"
          controls = []
          onSubmission?.()
        },
      }
    },
  }
  const activeGuards = new Set<unknown>()
  const context = {
    newCDPSession: async () => ({
      send: async () => ({ targetInfo: { targetId: "synthetic-native-page" } }),
      detach: async () => {},
    }),
    route: async (_pattern: string, handler: unknown) => {
      activeGuards.add(handler)
    },
    unroute: async (_pattern: string, handler: unknown) => {
      activeGuards.delete(handler)
    },
  }
  const page = {
    ...frame,
    context: () => context,
    frames: () => [frame],
    screenshot: async () => Buffer.from("synthetic-screenshot"),
    setViewportSize: async () => {},
    waitForLoadState: async () => {},
    url: () => "https://synthetic.example.test/receipt",
  } as unknown as Page
  return {
    page,
    setNotices: (value: string) => {
      notices = value
    },
    whenUploaded: (callback: (name: string) => void) => {
      onUpload = callback
    },
    nativePlanner: (
      extract: (prompt: string, timeout?: number) => Promise<unknown>
    ) =>
      bindBrowserUse(page.context(), async (run) => {
        let state = JSON.parse(JSON.stringify(await run.execute("observe", {})))
        for (let turn = 0; turn < 12 && !state.done; turn++) {
          if (!state.reviewed) {
            await run.reserveDecision()
            const plan = z
              .object({
                fields: z.array(applicationFieldDescription),
                expandTarget: z.string().nullable(),
                entryTarget: z.string().nullable(),
              })
              .strict()
              .parse(
                await extract(
                  "current job application. Never combine first and last name controls. " +
                    JSON.stringify(state.screen),
                  run.timeout
                )
              )
            state = await run.execute("review", {
              epoch: state.screen.epoch,
              fields: plan.fields,
            })
          } else if (!state.filled) {
            state = await run.execute("fill", { epoch: state.screen.epoch })
          } else {
            const next = state.screen.controls.find((c: ComputerControl) =>
              /^(next|continue)$/i.test(c.label)
            )
            const target =
              next ||
              state.screen.controls.find((c: ComputerControl) =>
                /submit/i.test(c.label)
              )
            state = await run.execute(next ? "advance" : "ready", {
              epoch: state.screen.epoch,
              target: target.target,
            })
          }
        }
      }),
    activeGuards,
    uploads: () => uploads,
    whenDocumentRead: (callback: () => void) => {
      onDocumentRead = callback
    },
    addControl: (item: ComputerControl) => {
      controls.splice(controls.length - 1, 0, item)
    },
    replaceDocument: () => {
      selectedDocument = Buffer.from("unapproved replacement file")
    },
    boundary: () => {
      boundary = true
    },
    submissions: () => submissions,
    whenSubmitted: (callback: () => void) => {
      onSubmission = callback
    },
    locatorReads: () => locatorReads,
    challengeOnSubmit: () => {
      challengeOnSubmit = true
    },
    showChallenge: () => {
      challengeVisible = true
    },
    completeHumanVerification: () => {
      challengeVisible = false
    },
    failNextFill: (fail: () => void) => {
      fillFailure = fail
    },
    updateControl: (changes: Partial<ComputerControl>) => {
      Object.assign(controls[0], changes)
    },
    updateSubmit: (changes: Partial<ComputerControl>) => {
      Object.assign(controls.find((c) => c.id === "send")!, changes)
    },
    addRequiredQuestion: () => {
      controls.splice(
        controls.length - 1,
        0,
        control({
          target: "c2",
          id: "salary",
          name: "salary",
          selector: "#salary",
          type: "number",
          label: "Salary expectation",
          required: true,
        })
      )
    },
  }
}

for (const changedPolicy of [false, true]) {
  test(`approved upload filename does not hide ${changedPolicy ? "a changed policy" : "an otherwise unchanged manual form"}`, async (t) => {
    modelEnvironment(t)
    const f = browserFixture(
      control({
        id: "resume",
        name: "resume",
        type: "file",
        label: "Resume",
        value: "",
      })
    )
    f.setNotices("Application privacy policy")
    f.whenUploaded((name) =>
      f.setNotices(
        `Application privacy policy ${name}${changedPolicy ? " We now share your data with partners." : ""}`
      )
    )
    const approved = {
      ...packet,
      notices: "Application privacy policy",
      fields: [
        {
          ...packet.fields[0],
          id: "resume",
          label: "Resume",
          kind: "resume" as const,
        },
      ],
      answers: {},
    }
    const unbind = f.nativePlanner(async () =>
      nativePlan([description({ label: "Resume", kind: "resume" })])
    )
    t.mock.method(globalThis, "fetch", async () =>
      Response.json({
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: JSON.stringify({
                confirmed: true,
                text: "Thank you for applying",
              }),
            },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      })
    )
    try {
      const result = await runComputerApplication(f.page, approved, {
        planner: "browser-use",
        automatic: false,
        reserveDecision: async () => {},
        beforeSubmit: async (_packet, confirm) => {
          assert.equal(changedPolicy, false)
          f.boundary()
          await confirm()
        },
      })
      assert.equal(result.needsAnswers, changedPolicy)
      assert.equal(f.submissions(), changedPolicy ? 0 : 1)
      assert.equal(f.uploads(), 1)
    } finally {
      unbind()
    }
  })
}

test("Browser Use is the default, computer is explicit rollback and invalid configuration fails closed", () => {
  assert.equal(applicationFormPlanner(""), "browser-use")
  assert.equal(applicationFormPlanner("computer"), "computer")
  assert.equal(applicationFormPlanner("browser-use"), "browser-use")
  assert.throws(() => applicationFormPlanner("unknown"), /not configured/)
})
test("separate name inputs cannot be grouped into one full-name field", () => {
  const browser = observation([
    control({
      target: "c0",
      type: "text",
      label: "First name",
      group: "Name",
      name: "first",
      autocomplete: "given-name",
    }),
    control({
      target: "c1",
      type: "text",
      label: "Last name",
      group: "Name",
      name: "last",
      autocomplete: "family-name",
    }),
  ])
  assert.throws(
    () =>
      bindComputerFields(
        browser,
        1,
        [
          description({
            targets: ["c0", "c1"],
            label: "Full name",
            kind: "text",
          }),
        ],
        0
      ),
    /separate/
  )
})

test("default discovery uses structured Browser Use extraction without a screenshot-agent request", async (t) => {
  const f = browserFixture()
  let reservations = 0,
    extractions = 0
  t.mock.method(globalThis, "fetch", async () =>
    assert.fail("No screenshot planner or receipt call in discovery")
  )
  t.mock.method(f.page, "screenshot", async () =>
    assert.fail("Native discovery does not need screenshots")
  )
  const unbind = f.nativePlanner(async (prompt) => {
    extractions++
    assert.equal(reservations, extractions)
    assert.match(prompt, /"id":"email"/)
    assert.match(prompt, /"name":"email"/)
    assert.match(prompt, /"autocomplete":"email"/)
    assert.match(prompt, /Never combine first and last name controls/)
    return nativePlan()
  })
  try {
    const form = await discoverComputerForm(f.page, packet, async () => {
      reservations++
    })
    assert.equal(form.fields[0].kind, "email")
    assert.equal(form.fields[0].label, "Email")
    assert.equal(extractions, 1)
    assert.equal(f.submissions(), 0)
  } finally {
    unbind()
  }
})

for (const lateMutation of [false, true]) {
  test(`native filling preserves exact answers and ${lateMutation ? "blocks a late unapproved value" : "submits once through the backend gate"}`, async (t) => {
    modelEnvironment(t)
    const f = browserFixture()
    let modelCalls = 0,
      gates = 0
    t.mock.method(globalThis, "fetch", async () => {
      modelCalls++
      return Response.json({
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: JSON.stringify({
                confirmed: true,
                text: "Thank you for applying",
              }),
            },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      })
    })
    const unbind = f.nativePlanner(async () => nativePlan())
    try {
      const run = runComputerApplication(f.page, packet, {
        planner: "browser-use",
        automatic: true,
        reserveDecision: async () => {},
        beforeSubmit: async (_latest, confirm) => {
          gates++
          f.boundary()
          if (lateMutation)
            f.updateControl({ value: "unapproved@example.test" })
          const first = confirm()
          assert.equal(
            confirm(),
            first,
            "A second confirmation cannot click again"
          )
          await first
        },
      })
      if (lateMutation)
        await assert.rejects(run, /no longer matches approved answer/)
      else assert.equal((await run).needsAnswers, false)
      assert.equal(gates, 1)
      assert.equal(f.submissions(), lateMutation ? 0 : 1)
      assert.equal(
        modelCalls,
        lateMutation ? 0 : 1,
        "Only receipt verification uses the AI SDK model"
      )
    } finally {
      unbind()
    }
  })
}

test("native perception can complete two model calls under one bounded operation before submitting", async (t) => {
  modelEnvironment(t)
  const f = browserFixture()
  let now = 0
  t.mock.method(Date, "now", () => now)
  const unbind = f.nativePlanner(async (prompt, timeout) => {
    assert.match(prompt, /current job application/)
    if (!timeout || timeout < 40_000) {
      now += timeout || 0
      throw Object.assign(new Error("Native perception timed out"), {
        name: "TimeoutError",
      })
    }
    now += 40_000
    return nativePlan()
  })
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: {
            role: "assistant",
            content: JSON.stringify({
              confirmed: true,
              text: "Thank you for applying",
            }),
          },
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 20 },
    })
  )
  try {
    const result = await runComputerApplication(f.page, packet, {
      planner: "browser-use",
      automatic: true,
      deterministicFill: true,
      deadline: 770_000,
      reserveDecision: async () => {},
      beforeSubmit: async (_latest, confirm) => {
        f.boundary()
        await confirm()
      },
    })
    assert.equal(result.needsAnswers, false)
    assert.equal(f.submissions(), 1)
    assert.equal(now, 40_000)
  } finally {
    unbind()
  }
})

for (const outcome of ["finished", "errored", "active_timeout"] as const) {
  test(`a provider solve after Submit ${outcome} without a second click or a competing handoff`, async (t) => {
    modelEnvironment(t)
    const f = browserFixture()
    f.challengeOnSubmit()
    const events = new EventEmitter()
    const emit = (text: string) => events.emit("console", { text: () => text })
    let now = 0,
      handoffs = 0,
      receipts = 0,
      settled = false
    t.mock.method(Date, "now", () => now)
    Object.assign(f.page, {
      on: events.on.bind(events),
      off: events.off.bind(events),
      waitForTimeout: async (ms: number) => {
        now += ms
        if (!settled && now >= 500 && outcome !== "active_timeout") {
          settled = true
          emit(`browserbase-solving-${outcome}`)
          if (outcome === "finished") f.completeHumanVerification()
        }
      },
    })
    const stop = trackBrowserbaseCaptcha(f.page)
    f.whenSubmitted(() => emit("browserbase-solving-started"))
    t.mock.method(globalThis, "fetch", async () => {
      receipts++
      return Response.json({
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: JSON.stringify({
                confirmed: true,
                text: "Thank you for applying",
              }),
            },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      })
    })
    const unbind = f.nativePlanner(async () => nativePlan())
    try {
      const result = runComputerApplication(f.page, packet, {
        planner: "browser-use",
        automatic: true,
        deterministicFill: true,
        deadline: 770_000,
        reserveDecision: async () => {},
        humanVerification: async (ready) => {
          handoffs++
          assert.equal(outcome, "errored")
          // The provider stopped at 500ms. The worker owns any remaining
          // automatic fallback wait; this receipt callback must not nest it.
          assert.equal(now, 500)
          assert.equal(await ready(), false)
          assert.equal(now, 500)
          f.completeHumanVerification()
          assert.equal(await ready(), true)
        },
        beforeSubmit: async (_latest, confirm) => {
          f.boundary()
          await confirm()
        },
      })
      if (outcome === "active_timeout")
        await assert.rejects(result, /solver still active/)
      else assert.equal((await result).needsAnswers, false)
      assert.equal(f.submissions(), 1)
      assert.equal(handoffs, outcome === "errored" ? 1 : 0)
      assert.equal(receipts, outcome === "active_timeout" ? 0 : 1)
    } finally {
      unbind()
      stop()
    }
  })
}

test("native filling clicks Submit once and retains the same browser through a long CAPTCHA wait and receipt save", async (t) => {
  modelEnvironment(t)
  const f = browserFixture()
  f.challengeOnSubmit()
  let now = Date.now(),
    calls = 0,
    handoffs = 0,
    releases = 0,
    saved = false
  const deadline = now + 770_000
  t.mock.method(Date, "now", () => now)
  t.mock.method(globalThis, "fetch", async () => {
    calls++
    return Response.json({
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: {
            role: "assistant",
            content: JSON.stringify({
              confirmed: true,
              text: "Thank you for applying",
            }),
          },
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 20 },
    })
  })
  const unbind = f.nativePlanner(async () => {
    if (!f.submissions()) now += 61_000
    return nativePlan()
  })
  try {
    const result = await runComputerApplication(f.page, packet, {
      planner: "browser-use",
      automatic: true,
      deterministicFill: true,
      deadline,
      reserveDecision: async () => {},
      humanVerification: async (ready) => {
        handoffs++
        assert.equal(f.submissions(), 1)
        assert.equal(releases, 0)
        assert.equal(await ready(), false)
        now += HUMAN_VERIFICATION_WAIT_MS - 5_000
        f.completeHumanVerification()
        assert.equal(await ready(), true)
      },
      releaseBrowser: async () => {
        assert.equal(
          saved,
          true,
          "Keep the browser through receipt persistence"
        )
        releases++
      },
      beforeSubmit: async (_latest, confirm) => {
        f.boundary()
        const first = confirm()
        assert.equal(confirm(), first)
        assert.equal((await first).text, "Thank you for applying")
        saved = true
      },
    })
    assert.equal(result.needsAnswers, false)
    assert.equal(f.submissions(), 1)
    assert.equal(handoffs, 1)
    assert.equal(releases, 1)
    assert.equal(calls, 1)
  } finally {
    unbind()
  }
})

test("submission requires time for a full human window plus click and receipt processing", async () => {
  const f = browserFixture()
  const unbind = f.nativePlanner(async () => nativePlan())
  try {
    await assert.rejects(
      runComputerApplication(f.page, packet, {
        planner: "browser-use",
        automatic: true,
        deadline:
          Date.now() +
          HUMAN_VERIFICATION_WAIT_MS +
          2 * SUBMISSION_RESERVE_MS -
          1,
        reserveDecision: async () => {},
        humanVerification: async () =>
          assert.fail("Do not begin sending without enough assistance time"),
        beforeSubmit: async () =>
          assert.fail(
            "Do not persist intent or click with a truncated human window"
          ),
      }),
      /time budget exceeded/
    )
    assert.equal(f.submissions(), 0)
  } finally {
    unbind()
  }
})

test("native extraction cannot invent a salary or skip a newly required question", async () => {
  const f = browserFixture()
  f.addRequiredQuestion()
  const unbind = f.nativePlanner(async () =>
    nativePlan([
      description(),
      description({
        targets: ["c1"],
        label: "Salary expectation",
        kind: "number",
      }),
    ])
  )
  try {
    const result = await runComputerApplication(f.page, packet, {
      planner: "browser-use",
      automatic: true,
      reserveDecision: async () => {},
      beforeSubmit: async () =>
        assert.fail("Missing salary must pause before sending"),
    })
    assert.equal(result.needsAnswers, true)
    assert.equal(result.packet.answers.salary, undefined)
    assert.equal(f.submissions(), 0)
  } finally {
    unbind()
  }
})

for (const invalid of [
  "invented-target",
  "omitted-required",
  "candidate-answers",
] as const) {
  test(`native proposals cannot bypass validation: ${invalid}`, async (t) => {
    const f = browserFixture()
    if (invalid === "omitted-required") f.addRequiredQuestion()
    let extractions = 0
    t.mock.method(globalThis, "fetch", async () =>
      assert.fail("No planner fallback or receipt inference")
    )
    const unbind = f.nativePlanner(async () => {
      extractions++
      return invalid === "invented-target"
        ? nativePlan([description({ targets: ["invented"] })])
        : invalid === "candidate-answers"
          ? { ...nativePlan(), answers: { email: "invented@example.test" } }
          : nativePlan()
    })
    try {
      await assert.rejects(
        discoverComputerForm(
          f.page,
          packet,
          async () => {},
          Infinity,
          true,
          "browser-use"
        )
      )
      assert.ok(extractions <= 3)
      assert.equal(f.submissions(), 0)
    } finally {
      unbind()
    }
  })
}

test("native provider failure and quota denial never fall back to the screenshot agent", async (t) => {
  const f = browserFixture()
  t.mock.method(globalThis, "fetch", async () =>
    assert.fail("No hidden fallback")
  )
  let extractions = 0
  const unbind = f.nativePlanner(async () => {
    extractions++
    throw new Error("Native provider unavailable")
  })
  try {
    await assert.rejects(
      discoverComputerForm(
        f.page,
        packet,
        async () => {},
        Infinity,
        true,
        "browser-use"
      ),
      /unavailable/
    )
    assert.equal(extractions, 1)
    await assert.rejects(
      discoverComputerForm(
        f.page,
        packet,
        async () => {
          throw new Error("Application decision quota reached")
        },
        Infinity,
        true,
        "browser-use"
      ),
      /quota reached/
    )
    assert.equal(extractions, 1)
    assert.equal(f.submissions(), 0)
  } finally {
    unbind()
  }
})

for (const solved of [true, false]) {
  test(`a post-submit challenge ${solved ? "continues receipt verification" : "expires safely"} without submitting twice`, async (t) => {
    modelEnvironment(t)
    const fixture = browserFixture()
    fixture.challengeOnSubmit()
    let calls = 0,
      handoffs = 0
    t.mock.method(
      globalThis,
      "fetch",
      async (_url: unknown, init: RequestInit) => {
        calls++
        if (calls === 4)
          return Response.json({
            choices: [
              {
                index: 0,
                finish_reason: "stop",
                message: {
                  role: "assistant",
                  content: JSON.stringify({
                    confirmed: true,
                    text: "Thank you for applying",
                  }),
                },
              },
            ],
            usage: { prompt_tokens: 100, completion_tokens: 20 },
          })
        const body = JSON.parse(String(init.body))
        const message = body.messages.find(
          (m: { role: string }) => m.role === "user"
        )
        const state = JSON.parse(
          message.content.find((p: { type: string }) => p.type === "text").text
        )
        return calls === 2
          ? toolResponse("fill", { epoch: state.screen.epoch })
          : toolResponse("review", {
              epoch: state.screen.epoch,
              fields: [description()],
            })
      }
    )
    const result = runComputerApplication(fixture.page, packet, {
      automatic: true,
      reserveDecision: async () => {},
      humanVerification: async (ready) => {
        handoffs++
        assert.equal(fixture.submissions(), 1)
        assert.equal(await ready(), false)
        if (!solved)
          throw new Error(
            "Human verification required; assistance time expired"
          )
        fixture.completeHumanVerification()
        assert.equal(await ready(), true)
      },
      beforeSubmit: async (_latest, confirm) => {
        fixture.boundary()
        await confirm()
      },
    })
    if (solved) assert.equal((await result).needsAnswers, false)
    else await assert.rejects(result, { code: "verification_incomplete" })
    assert.equal(handoffs, 1)
    assert.equal(fixture.submissions(), 1)
    assert.equal(calls, solved ? 4 : 3)
  })
}

test("a browser fill failure refreshes the screen and unlocks review before retrying", async (t) => {
  modelEnvironment(t)
  const fixture = browserFixture()
  fixture.failNextFill(() => {
    fixture.updateControl({ selector: "#replacement-email" })
    throw new Error("Timeout 12000ms at https://private.invalid?answer=secret")
  })
  let calls = 0
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, init: RequestInit) => {
      calls++
      const body = JSON.parse(String(init.body))
      if (calls === 6)
        return Response.json({
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: JSON.stringify({
                  confirmed: true,
                  text: "Thank you for applying",
                }),
              },
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 20 },
        })
      const message = body.messages.find(
        (m: { role: string }) => m.role === "user"
      )
      const state = JSON.parse(
        message.content.find((p: { type: string }) => p.type === "text").text
      )
      if (calls === 3) {
        assert.equal(state.phase, "identify_questions")
        assert.equal(state.screen.epoch, 2)
        assert.equal(state.screen.controls[0].selector, "#replacement-email")
        assert.ok(
          body.tools.some(
            (tool: { function: { name: string } }) =>
              tool.function.name === "review"
          )
        )
        assert.doesNotMatch(
          JSON.stringify(state.history),
          /secret|private.invalid/
        )
      }
      return calls === 2 || calls === 4
        ? toolResponse("fill", { epoch: state.screen.epoch })
        : toolResponse("review", {
            epoch: state.screen.epoch,
            fields: [description()],
          })
    }
  )
  const result = await runComputerApplication(fixture.page, packet, {
    automatic: true,
    reserveDecision: async () => {},
    beforeSubmit: async (latest, confirm) => {
      assert.equal(latest.answers.email, packet.answers.email)
      fixture.boundary()
      await confirm()
    },
  })
  assert.equal(result.needsAnswers, false)
  assert.equal(fixture.submissions(), 1)
  assert.equal(calls, 6)
})

test("omitted required controls are identified by safe observed targets so review can recover", async (t) => {
  modelEnvironment(t)
  const fixture = browserFixture()
  fixture.addRequiredQuestion()
  let calls = 0
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, init: RequestInit) => {
      calls++
      const body = JSON.parse(String(init.body))
      const message = body.messages.find(
        (m: { role: string }) => m.role === "user"
      )
      const state = JSON.parse(
        message.content.find((p: { type: string }) => p.type === "text").text
      )
      const fields = [description()]
      if (calls === 2) {
        assert.match(
          state.history.at(-1),
          /required employer question was omitted.*c1/
        )
        assert.doesNotMatch(state.history.at(-1), /Salary|#salary/)
        fields.push(
          description({
            targets: ["c1"],
            label: "Salary expectation",
            kind: "number",
          })
        )
      }
      return toolResponse("review", { epoch: state.screen.epoch, fields })
    }
  )
  const result = await runComputerApplication(fixture.page, packet, {
    automatic: true,
    reserveDecision: async () => {},
    beforeSubmit: async () =>
      assert.fail("An unanswered question must never be submitted"),
  })
  assert.equal(result.needsAnswers, true)
  assert.equal(result.packet.answers.email, packet.answers.email)
  assert.equal(fixture.submissions(), 0)
  assert.equal(calls, 2)
})

test("a follow-up review can correct an omitted filled control and submit exactly once", async (t) => {
  modelEnvironment(t)
  const fixture = browserFixture()
  fixture.addRequiredQuestion()
  const approved = {
    ...packet,
    fields: [
      ...packet.fields,
      {
        ...packet.fields[0],
        id: "salary",
        label: "Salary expectation",
        kind: "number" as const,
      },
    ],
    answers: { ...packet.answers, salary: "73000" },
  }
  let calls = 0
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, init: RequestInit) => {
      calls++
      if (calls === 5)
        return Response.json({
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: JSON.stringify({
                  confirmed: true,
                  text: "Thank you for applying",
                }),
              },
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 20 },
        })
      const body = JSON.parse(String(init.body))
      const message = body.messages.find(
        (m: { role: string }) => m.role === "user"
      )
      const state = JSON.parse(
        message.content.find((p: { type: string }) => p.type === "text").text
      )
      if (calls === 4) assert.match(state.history.at(-1), /omitted.*c1/)
      const fields = [description()]
      if (calls !== 3)
        fields.push(
          description({
            targets: ["c1"],
            label: "Salary expectation",
            kind: "number",
          })
        )
      return calls === 2
        ? toolResponse("fill", { epoch: state.screen.epoch })
        : toolResponse("review", { epoch: state.screen.epoch, fields })
    }
  )
  const result = await runComputerApplication(fixture.page, approved, {
    automatic: true,
    reserveDecision: async () => {},
    beforeSubmit: async (latest, confirm) => {
      assert.deepEqual(latest.answers, approved.answers)
      fixture.boundary()
      await confirm()
    },
  })
  assert.equal(result.needsAnswers, false)
  assert.equal(fixture.submissions(), 1)
  assert.equal(calls, 5)
})

test("re-reviewing after failed fills does not reset the three-failure limit", async (t) => {
  modelEnvironment(t)
  const fixture = browserFixture()
  const fail = () => {
    fixture.failNextFill(fail)
    throw new Error("Timeout 12000ms during browser fill")
  }
  fixture.failNextFill(fail)
  let calls = 0
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, init: RequestInit) => {
      assert.ok(
        ++calls <= 6,
        "Do not exhaust the model budget on identical failed fills"
      )
      const body = JSON.parse(String(init.body))
      const message = body.messages.find(
        (m: { role: string }) => m.role === "user"
      )
      const state = JSON.parse(
        message.content.find((p: { type: string }) => p.type === "text").text
      )
      return state.phase === "fill_answers"
        ? toolResponse("fill", { epoch: state.screen.epoch })
        : toolResponse("review", {
            epoch: state.screen.epoch,
            fields: [description()],
          })
    }
  )
  await assert.rejects(
    runComputerApplication(fixture.page, packet, {
      automatic: true,
      reserveDecision: async () => {},
      beforeSubmit: async () =>
        assert.fail("Persistent fill failures cannot submit"),
    }),
    /Unsupported employer control/
  )
  assert.equal(fixture.submissions(), 0)
  assert.equal(calls, 6)
})

test("mapping errors interleaved with failed fills cannot reset the actual fill budget", async (t) => {
  modelEnvironment(t)
  const f = browserFixture()
  const fail = () => {
    f.failNextFill(fail)
    throw new Error("Timeout 12000ms during browser fill")
  }
  f.failNextFill(fail)
  let calls = 0
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, init: RequestInit) => {
      assert.ok(
        ++calls <= 5,
        "Mapping corrections must not extend three failed fills"
      )
      const body = JSON.parse(String(init.body))
      const state = JSON.parse(
        body.messages
          .find((m: { role: string }) => m.role === "user")
          .content.find((p: { type: string }) => p.type === "text").text
      )
      return toolResponse("review", {
        epoch: state.screen.epoch,
        fields: [description({ targets: [calls % 2 ? "c0" : "c999"] })],
      })
    }
  )
  await assert.rejects(
    runComputerApplication(f.page, packet, {
      automatic: true,
      deterministicFill: true,
      reserveDecision: async () => {},
      beforeSubmit: async () =>
        assert.fail("Repeated fill failures cannot send"),
    }),
    /Unsupported employer control/
  )
  assert.equal(calls, 5)
  assert.equal(f.submissions(), 0)
})

test("a dropdown mismatch returns observed choices for confirmation without replacing the approved answer", async (t) => {
  modelEnvironment(t)
  const fixture = browserFixture(
    control({
      id: "location",
      label: "Location",
      type: "text",
      role: "combobox",
    }),
    "Example City"
  )
  const approved = {
    ...packet,
    fields: [
      {
        ...packet.fields[0],
        id: "location",
        label: "Location",
        kind: "combobox" as const,
      },
    ],
    answers: { location: "Example City" },
  }
  fixture.failNextFill(() => {
    fixture.updateControl({ options: ["Example City, Region, Country"] })
    throw new Error("Timeout 12000ms waiting for an exact dropdown option")
  })
  let calls = 0
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, init: RequestInit) => {
      calls++
      const body = JSON.parse(String(init.body))
      const message = body.messages.find(
        (m: { role: string }) => m.role === "user"
      )
      const state = JSON.parse(
        message.content.find((p: { type: string }) => p.type === "text").text
      )
      if (calls === 3) assert.equal(state.phase, "identify_questions")
      return calls === 2
        ? toolResponse("fill", { epoch: state.screen.epoch })
        : toolResponse("review", {
            epoch: state.screen.epoch,
            fields: [description({ label: "Location", kind: "combobox" })],
          })
    }
  )
  const result = await runComputerApplication(fixture.page, approved, {
    automatic: true,
    reserveDecision: async () => {},
    beforeSubmit: async () =>
      assert.fail("A different dropdown choice requires confirmation"),
  })
  assert.equal(result.needsAnswers, true)
  assert.deepEqual(result.packet.fields[0].options, [
    "Example City, Region, Country",
  ])
  assert.equal(result.packet.answers.location, undefined)
  assert.equal(approved.answers.location, "Example City")
  assert.equal(fixture.submissions(), 0)
  assert.equal(calls, 3)
})

test("search-backed location dropdown types only the approved value before selecting its exact option", async (t) => {
  modelEnvironment(t)
  const location = "Hyderabad, Telangana, India"
  const fixture = browserFixture(
    control({
      id: "location",
      name: "location",
      role: "combobox",
      type: "text",
      label: "Current location",
    }),
    location
  )
  const field = {
    ...packet.fields[0],
    id: "location",
    label: "Current location",
    kind: "combobox" as const,
    options: [],
  }
  const approved = { ...packet, fields: [field], answers: { location } }
  let calls = 0
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, init: RequestInit) => {
      calls++
      if (calls === 4)
        return Response.json({
          id: "receipt",
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: JSON.stringify({
                  confirmed: true,
                  text: "Thank you for applying",
                }),
              },
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 20 },
        })
      const message = JSON.parse(String(init.body)).messages.find(
        (m: { role: string }) => m.role === "user"
      )
      const screen = JSON.parse(
        message.content.find((p: { type: string }) => p.type === "text").text
      ).screen
      return calls === 2
        ? toolResponse("fill", { epoch: screen.epoch })
        : toolResponse("review", {
            epoch: screen.epoch,
            fields: [
              description({ label: "Current location", kind: "combobox" }),
            ],
          })
    }
  )
  const result = await runComputerApplication(fixture.page, approved, {
    automatic: true,
    reserveDecision: async () => {},
    beforeSubmit: async (_latest, confirm) => {
      fixture.boundary()
      await confirm()
    },
  })
  assert.equal(result.needsAnswers, false)
  assert.equal(fixture.submissions(), 1)
})
function modelEnvironment(t: TestContext) {
  const env = {
    TAILORING_BASE_URL: "https://model.example.test/v1",
    TAILORING_MODEL: "source-model",
    TAILORING_API_KEY: "synthetic-key",
    APPLICATION_COMPUTER_MODEL: "synthetic-vision-model",
    APPLICATION_RECEIPT_MODEL: "",
    // These existing regressions exercise the retained screenshot planner.
    // Native/default discovery and shared submission gates are tested separately.
    APPLICATION_FORM_PLANNER: "computer",
  }
  const old = Object.fromEntries(
    Object.keys(env).map((k) => [k, process.env[k]])
  )
  Object.assign(process.env, env)
  t.after(() => {
    for (const [k, v] of Object.entries(old)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })
}

for (const changed of [{ value: "changed@example.test" }, { valid: false }]) {
  test(`the final backend gate rejects late ${"value" in changed ? "answer" : "validity"} changes before clicking Submit`, async (t) => {
    modelEnvironment(t)
    const fixture = browserFixture()
    let calls = 0
    t.mock.method(
      globalThis,
      "fetch",
      async (_url: unknown, init: RequestInit) => {
        calls++
        if (calls === 4)
          return Response.json({
            choices: [
              {
                index: 0,
                finish_reason: "stop",
                message: {
                  role: "assistant",
                  content: JSON.stringify({
                    confirmed: true,
                    text: "Thank you for applying",
                  }),
                },
              },
            ],
            usage: { prompt_tokens: 100, completion_tokens: 20 },
          })
        const state = JSON.parse(
          JSON.parse(String(init.body))
            .messages.find((m: { role: string }) => m.role === "user")
            .content.find((p: { type: string }) => p.type === "text").text
        )
        return calls === 2
          ? toolResponse("fill", { epoch: state.screen.epoch })
          : toolResponse("review", {
              epoch: state.screen.epoch,
              fields: [description()],
            })
      }
    )
    await assert.rejects(
      runComputerApplication(fixture.page, packet, {
        automatic: true,
        reserveDecision: async () => {},
        beforeSubmit: async (_latest, confirm) => {
          fixture.boundary()
          fixture.updateControl(changed)
          await confirm()
        },
      }),
      /no longer matches approved answer|Employer rejected a field/
    )
    assert.equal(fixture.submissions(), 0)
    assert.equal(calls, 3)
  })
}
function toolResponse(name: string, args: unknown) {
  return Response.json({
    id: "computer-test",
    object: "chat.completion",
    created: 0,
    model: "synthetic-vision-model",
    choices: [
      {
        index: 0,
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call-computer",
              type: "function",
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        },
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 20 },
  })
}

test("the final backend gate rejects a consent checkbox changed after approval", async (t) => {
  modelEnvironment(t)
  const fixture = browserFixture(
    control({
      type: "checkbox",
      label: "I agree",
      group: "Application consent",
      id: "consent",
      name: "consent",
      selector: "#consent",
    })
  )
  const approved = {
    ...packet,
    fields: [
      {
        ...packet.fields[0],
        id: "consent",
        label: "Application consent",
        kind: "checkbox" as const,
        options: ["I agree"],
      },
    ],
    answers: { consent: ["I agree"] },
  }
  let calls = 0
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, init: RequestInit) => {
      calls++
      assert.ok(calls <= 3, "No receipt call before safe submission")
      const state = JSON.parse(
        JSON.parse(String(init.body))
          .messages.find((m: { role: string }) => m.role === "user")
          .content.find((p: { type: string }) => p.type === "text").text
      )
      return calls === 2
        ? toolResponse("fill", { epoch: state.screen.epoch })
        : toolResponse("review", {
            epoch: state.screen.epoch,
            fields: [
              description({
                label: "Application consent",
                kind: "checkbox",
                options: ["I agree"],
              }),
            ],
          })
    }
  )
  await assert.rejects(
    runComputerApplication(fixture.page, approved, {
      automatic: true,
      reserveDecision: async () => {},
      beforeSubmit: async (_latest, confirm) => {
        fixture.boundary()
        fixture.updateControl({ checked: false })
        await confirm()
      },
    }),
    /no longer matches approved answer/
  )
  assert.equal(fixture.submissions(), 0)
})
test("actual AI SDK loop receives a screenshot and reserves quota before reading a generic form", async (t) => {
  modelEnvironment(t)
  const fixture = browserFixture()
  let reservations = 0,
    calls = 0
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, init: RequestInit) => {
      calls++
      assert.equal(reservations, calls)
      const body = JSON.parse(String(init.body))
      assert.equal(body.model, "synthetic-vision-model")
      assert.ok(
        body.messages.some(
          (m: { content?: { type: string }[] }) =>
            Array.isArray(m.content) &&
            m.content.some((p) => p.type === "image_url")
        )
      )
      const message = body.messages.find(
        (m: { role: string }) => m.role === "user"
      )
      const screen = JSON.parse(
        message.content.find((p: { type: string }) => p.type === "text").text
      ).screen
      return toolResponse("review", {
        epoch: screen.epoch,
        fields: [description()],
        notices: "",
      })
    }
  )
  const form = await discoverComputerForm(fixture.page, packet, async () => {
    reservations++
  })
  assert.equal(form.fields[0].label, "Email")
  assert.equal(calls, 1)
  assert.equal(fixture.submissions(), 0)
})
for (const filling of [false, true]) {
  test(`repeated observation cannot exhaust the ${filling ? "filling" : "discovery"} budget on a visible form`, async (t) => {
    modelEnvironment(t)
    const fixture = browserFixture()
    let observations = 0,
      calls = 0,
      boundaries = 0
    t.mock.method(
      globalThis,
      "fetch",
      async (_url: unknown, init: RequestInit) => {
        calls++
        const body = JSON.parse(String(init.body))
        if (body.response_format)
          return Response.json({
            id: "receipt",
            choices: [
              {
                index: 0,
                finish_reason: "stop",
                message: {
                  role: "assistant",
                  content: JSON.stringify({
                    confirmed: true,
                    text: "Thank you for applying",
                  }),
                },
              },
            ],
            usage: { prompt_tokens: 100, completion_tokens: 20 },
          })
        // Replay the production model's preference for the zero-argument
        // observe tool whenever it is offered. Use the real SDK/tool loop.
        if (
          body.tools.some(
            (t: { function: { name: string } }) => t.function.name === "observe"
          )
        ) {
          observations++
          return toolResponse("observe", {})
        }
        const message = body.messages.find(
          (m: { role: string }) => m.role === "user"
        )
        const { screen } = JSON.parse(
          message.content.find((p: { type: string }) => p.type === "text").text
        )
        return toolResponse("review", {
          epoch: screen.epoch,
          fields: [description()],
        })
      }
    )
    if (filling) {
      const result = await runComputerApplication(fixture.page, packet, {
        automatic: true,
        deterministicFill: true,
        reserveDecision: async () => {},
        beforeSubmit: async (_latest, confirm) => {
          boundaries++
          fixture.boundary()
          assert.equal((await confirm()).text, "Thank you for applying")
        },
      })
      assert.equal(result.needsAnswers, false)
      assert.equal(fixture.submissions(), 1)
      assert.equal(boundaries, 1)
    } else {
      const form = await discoverComputerForm(
        fixture.page,
        packet,
        async () => {}
      )
      assert.equal(form.fields[0].label, "Email")
      assert.equal(fixture.submissions(), 0)
    }
    assert.equal(observations, 1)
    assert.equal(calls, filling ? 3 : 2)
  })
}
test("a provider repeating an inactive observation tool stops before exhausting the budget", async (t) => {
  modelEnvironment(t)
  const fixture = browserFixture()
  let calls = 0
  t.mock.method(globalThis, "fetch", async () => {
    calls++
    return toolResponse("observe", {})
  })
  await assert.rejects(
    runComputerApplication(fixture.page, packet, {
      automatic: true,
      reserveDecision: async () => {},
      beforeSubmit: async () =>
        assert.fail("No send before reviewing the form"),
    }),
    /Unsupported employer control/
  )
  assert.equal(calls, 4) // One refresh, then the existing three-failure bound.
  assert.equal(fixture.submissions(), 0)
})

test("pre-submit field help keeps the same browser, requires approved values and revalidates before one send", async (t) => {
  modelEnvironment(t)
  const f = browserFixture()
  f.failNextFill(() => {
    throw new Error("Timeout 12000ms during browser fill")
  })
  let calls = 0,
    handoffs = 0
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, init: RequestInit) => {
      calls++
      const body = JSON.parse(String(init.body))
      const state = JSON.parse(
        body.messages
          .find((m: { role: string }) => m.role === "user")
          .content.find((p: { type: string }) => p.type === "text").text
      )
      if (state.visibleText !== undefined)
        return Response.json({
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: JSON.stringify({
                  confirmed: true,
                  text: "Thank you for applying",
                }),
              },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 10 },
        })
      return calls === 2
        ? toolResponse("pause", { reason: "unsupported_control" })
        : toolResponse("review", {
            epoch: state.screen.epoch,
            fields: [description()],
          })
    }
  )
  const result = await runComputerApplication(f.page, packet, {
    automatic: true,
    deterministicFill: true,
    reserveDecision: async () => {},
    fieldAssistance: async (ready) => {
      handoffs++
      assert.equal(f.activeGuards.size, 1)
      assert.equal(f.submissions(), 0)
      assert.equal(await ready(), false)
      f.updateControl({ value: "unapproved@example.test" })
      assert.equal(await ready(), false)
      f.updateControl({ value: packet.answers.email as string })
      assert.equal(await ready(), true)
    },
    beforeSubmit: async (_latest, confirm) => {
      assert.equal(f.activeGuards.size, 0)
      f.boundary()
      await confirm()
    },
  })
  assert.equal(result.needsAnswers, false)
  assert.equal(handoffs, 1)
  assert.equal(f.submissions(), 1)
  assert.equal(calls, 4)
})

test("field-help traffic cannot send or navigate and always removes only its own guard", async () => {
  let guard: ((route: unknown) => Promise<void>) | undefined
  let cleaned = false
  const page = {
    context: () => ({
      route: async (_pattern: string, handler: typeof guard) => {
        guard = handler
      },
      unroute: async (_pattern: string, handler: typeof guard) => {
        assert.equal(handler, guard)
        cleaned = true
      },
    }),
  } as unknown as Page
  await assert.rejects(
    withFieldAssistance(page, async () => {
      for (const [method, navigation, expected] of [
        ["POST", false, "abort"],
        ["GET", true, "abort"],
        ["GET", false, "fallback"],
        ["PUT", false, "abort"],
      ] as const) {
        let action = ""
        await guard!({
          request: () => ({
            method: () => method,
            isNavigationRequest: () => navigation,
          }),
          abort: async () => {
            action = "abort"
          },
          fallback: async () => {
            action = "fallback"
          },
        })
        assert.equal(action, expected)
      }
      throw new Error("helper expired")
    }),
    /helper expired/
  )
  assert.equal(cleaned, true)
})

for (const tamper of [false, true]) {
  test(`selected documents ${tamper ? "changed after approval are rejected" : "are replaced with the approved file on first encounter"}`, async (t) => {
    modelEnvironment(t)
    const f = browserFixture(
      control({
        id: "resume",
        name: "resume",
        selector: "#resume",
        type: "file",
        label: "Resume",
        value: "[file selected]",
      })
    )
    const approved = {
      ...packet,
      fields: [
        {
          ...packet.fields[0],
          id: "resume",
          label: "Resume",
          kind: "resume" as const,
        },
      ],
      answers: {},
    }
    t.mock.method(
      globalThis,
      "fetch",
      async (_url: unknown, init: RequestInit) => {
        const body = JSON.parse(String(init.body))
        const state = JSON.parse(
          body.messages
            .find((m: { role: string }) => m.role === "user")
            .content.find((p: { type: string }) => p.type === "text").text
        )
        if (state.visibleText !== undefined)
          return Response.json({
            choices: [
              {
                index: 0,
                finish_reason: "stop",
                message: {
                  role: "assistant",
                  content: JSON.stringify({
                    confirmed: true,
                    text: "Thank you for applying",
                  }),
                },
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 10 },
          })
        return toolResponse("review", {
          epoch: state.screen.epoch,
          fields: [description({ label: "Resume", kind: "resume" })],
        })
      }
    )
    const run = () =>
      runComputerApplication(f.page, approved, {
        automatic: true,
        deterministicFill: true,
        reserveDecision: async () => {},
        beforeSubmit: async (_latest, confirm) => {
          if (tamper) f.replaceDocument()
          f.boundary()
          await confirm()
        },
      })
    if (tamper) await assert.rejects(run(), /document no longer matches/)
    else await run()
    assert.equal(f.uploads(), 1)
    assert.equal(f.submissions(), tamper ? 0 : 1)
  })
}

test("early sign-in assistance allows only observed authentication writes and preserves send provenance", async () => {
  let guard: ((route: unknown) => Promise<void>) | undefined
  let cleaned = false
  const frame = {
    url: () => "https://employer.example/login",
    evaluate: async () => [
      {
        action: "https://employer.example/login",
        names: ["email", "password", "csrf"],
        credentials: ["password"],
        method: "POST",
      },
      {
        action: "https://employer.example/apply",
        names: ["resume", "email"],
        credentials: [],
        method: "POST",
      },
    ],
  }
  const challenge = {
    url: () => "https://challenge.example/captcha",
    evaluate: async () => [],
  }
  const page = {
    frames: () => [frame, challenge],
    context: () => ({
      route: async (_p: string, h: typeof guard) => {
        guard = h
      },
      unroute: async (_p: string, h: typeof guard) => {
        assert.equal(h, guard)
        cleaned = true
      },
    }),
  } as unknown as Page
  await withAuthenticationAssistance(page, async () => {
    for (const [url, method, navigation, keys, requestFrame, expected] of [
      [
        "https://employer.example/login",
        "POST",
        false,
        { email: "qa", password: "fictional", csrf: "fixture" },
        frame,
        "fallback",
      ],
      [
        "https://employer.example/apply",
        "POST",
        false,
        { email: "qa", resume: "fixture" },
        frame,
        "abort",
      ],
      [
        "https://employer.example/login",
        "POST",
        false,
        { resume: "fixture" },
        frame,
        "abort",
      ],
      ["https://employer.example/apply", "GET", true, {}, frame, "abort"],
      [
        "https://employer.example/new-application?email=qa",
        "GET",
        true,
        {},
        frame,
        "abort",
      ],
      [
        "https://employer.example/login?action=apply",
        "POST",
        false,
        { email: "qa", password: "fixture" },
        frame,
        "abort",
      ],
      [
        "https://employer.example/login",
        "POST",
        false,
        { email: "qa" },
        frame,
        "abort",
      ],
      [
        "https://challenge.example/verify",
        "POST",
        false,
        {},
        challenge,
        "fallback",
      ],
      ["https://employer.example/apply", "POST", false, {}, challenge, "abort"],
    ] as const) {
      let action = ""
      await guard!({
        request: () => ({
          url: () => url,
          method: () => method,
          isNavigationRequest: () => navigation,
          postDataJSON: () => keys,
          redirectedFrom: () => null,
          resourceType: () => (navigation ? "document" : "xhr"),
          frame: () => requestFrame,
        }),
        abort: async () => {
          action = "abort"
        },
        fallback: async () => {
          action = "fallback"
        },
      })
      assert.equal(action, expected)
    }
  })
  assert.equal(cleaned, true)
})

test("an approved first attachment cannot hide a second unapproved file", async (t) => {
  const browser = new ComputerBrowser({} as Page)
  let files = [
    new File(["approved"], "resume.pdf"),
    new File(["unapproved"], "other.pdf"),
  ]
  t.mock.method(
    browser,
    "locator",
    async () =>
      ({
        evaluate: async (
          fn: (node: HTMLInputElement) => Promise<number[] | null>
        ) => fn({ files } as unknown as HTMLInputElement),
      }) as unknown as Awaited<ReturnType<typeof browser.locator>>
  )
  assert.equal(await browser.fileHash(control({ type: "file" })), null)
  files = files.slice(0, 1)
  assert.match(
    String(await browser.fileHash(control({ type: "file" }))),
    /^[a-f0-9]{64}$/
  )
})

test("autofill during file verification is checked against a fresh complete form before sending", async (t) => {
  modelEnvironment(t)
  const f = browserFixture()
  f.addControl(
    control({
      id: "resume",
      name: "resume",
      selector: "#resume",
      type: "file",
      label: "Resume",
    })
  )
  const approved = {
    ...packet,
    fields: [
      ...packet.fields,
      {
        ...packet.fields[0],
        id: "resume",
        label: "Resume",
        kind: "resume" as const,
      },
    ],
  }
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body))
      const state = JSON.parse(
        body.messages
          .find((m: { role: string }) => m.role === "user")
          .content.find((p: { type: string }) => p.type === "text").text
      )
      return toolResponse("review", {
        epoch: state.screen.epoch,
        fields: [
          description(),
          description({ targets: ["c1"], label: "Resume", kind: "resume" }),
        ],
      })
    }
  )
  await assert.rejects(
    runComputerApplication(f.page, approved, {
      automatic: true,
      deterministicFill: true,
      reserveDecision: async () => {},
      beforeSubmit: async (_packet, confirm) => {
        f.whenDocumentRead(() =>
          f.updateControl({ value: "late-autofill@example.test" })
        )
        f.boundary()
        await confirm()
      },
    }),
    /no longer matches approved answer/
  )
  assert.equal(f.submissions(), 0)
})

test("a transient model error consumes one reservation and cannot issue hidden transport retries", async (t) => {
  modelEnvironment(t)
  const f = browserFixture()
  let calls = 0,
    reservations = 0
  t.mock.method(globalThis, "fetch", async () => {
    calls++
    return Response.json(
      { error: { message: "synthetic unavailable" } },
      { status: 503 }
    )
  })
  await assert.rejects(
    runComputerApplication(f.page, packet, {
      automatic: true,
      reserveDecision: async () => {
        reservations++
      },
      beforeSubmit: async () => assert.fail("Provider failure cannot submit"),
    })
  )
  assert.equal(calls, 1)
  assert.equal(reservations, 1)
  assert.equal(f.submissions(), 0)
})

test("computer fills only approved values and hands final submission to the backend exactly once", async (t) => {
  modelEnvironment(t)
  process.env.APPLICATION_RECEIPT_MODEL = "synthetic-receipt-model"
  const fixture = browserFixture()
  let calls = 0,
    reservations = 0,
    boundaries = 0
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, init: RequestInit) => {
      calls++
      assert.equal(reservations, calls)
      assert.equal(
        JSON.parse(String(init.body)).model,
        calls === 4 ? "synthetic-receipt-model" : "synthetic-vision-model"
      )
      if (calls === 4)
        return Response.json({
          id: "receipt",
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: JSON.stringify({
                  confirmed: true,
                  text: "Thank you for applying",
                }),
              },
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 20 },
        })
      const body = JSON.parse(String(init.body))
      const message = body.messages.find(
        (m: { role: string }) => m.role === "user"
      )
      const screen = JSON.parse(
        message.content.find((p: { type: string }) => p.type === "text").text
      ).screen
      if (calls === 1 || calls === 3)
        return toolResponse("review", {
          epoch: screen.epoch,
          fields: [description()],
          notices: "",
        })
      if (calls === 2) return toolResponse("fill", { epoch: screen.epoch })
      return toolResponse("ready", { epoch: screen.epoch, target: "c1" })
    }
  )
  const result = await runComputerApplication(fixture.page, packet, {
    automatic: true,
    reserveDecision: async () => {
      reservations++
    },
    beforeSubmit: async (latest, confirm) => {
      boundaries++
      assert.equal(latest.answers.email, "candidate@example.test")
      assert.equal(fixture.submissions(), 0)
      fixture.boundary()
      assert.equal((await confirm()).text, "Thank you for applying")
    },
  })
  assert.equal(result.needsAnswers, false)
  assert.equal(boundaries, 1)
  // Fill and final submission validate their target before acting.
  assert.ok(fixture.locatorReads() >= 3)
  assert.equal(fixture.submissions(), 1)
  assert.equal(calls, 4)
})
test("a newly observed required question can use an explicitly reusable answer before pausing", async (t) => {
  modelEnvironment(t)
  const fixture = browserFixture(
    control({
      id: "salary",
      name: "salary",
      selector: "#salary",
      type: "number",
      label: "Salary expectation",
      autocomplete: "",
    })
  )
  const saved: SavedQuestion = {
    id: "00000000-0000-4000-8000-000000000001",
    question: {
      ...packet.fields[0],
      id: "old-salary",
      label: "Salary expectation",
      kind: "number",
    },
    answer: "73000",
    reuse_scope: "employer",
    company: "Synthetic employer",
    country: "Germany",
    source_application_id: null,
    last_seen_at: new Date().toISOString(),
  }
  let calls = 0,
    lookups = 0
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, init: RequestInit) => {
      calls++
      if (calls === 4)
        return Response.json({
          id: "receipt",
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: JSON.stringify({
                  confirmed: true,
                  text: "Thank you for applying",
                }),
              },
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 20 },
        })
      const body = JSON.parse(String(init.body))
      const message = body.messages.find(
        (m: { role: string }) => m.role === "user"
      )
      const screen = JSON.parse(
        message.content.find((p: { type: string }) => p.type === "text").text
      ).screen
      return calls === 2
        ? toolResponse("fill", { epoch: screen.epoch })
        : toolResponse("review", {
            epoch: screen.epoch,
            fields: [
              description({ label: "Salary expectation", kind: "number" }),
            ],
          })
    }
  )
  const result = await runComputerApplication(fixture.page, packet, {
    automatic: true,
    reserveDecision: async () => {},
    savedAnswers: async (current) => {
      lookups++
      return applyRememberedAnswers(current, [saved])
    },
    beforeSubmit: async (current, confirm) => {
      assert.equal(current.answers.salary, "73000")
      assert.equal(current.rememberedAnswers?.salary.id, saved.id)
      fixture.boundary()
      await confirm()
    },
  })
  assert.equal(result.needsAnswers, false)
  assert.equal(fixture.submissions(), 1)
  assert.equal(calls, 4)
  assert.equal(lookups, 2)
})

test("receipt commentary is rejected after one click without retrying submission", async (t) => {
  modelEnvironment(t)
  const fixture = browserFixture()
  let calls = 0
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, init: RequestInit) => {
      calls++
      if (calls === 4)
        return Response.json({
          id: "receipt",
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: JSON.stringify({
                  confirmed: true,
                  text: "The screenshot confirms that the application was received successfully.",
                }),
              },
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 20 },
        })
      const body = JSON.parse(String(init.body))
      const message = body.messages.find(
        (m: { role: string }) => m.role === "user"
      )
      const screen = JSON.parse(
        message.content.find((p: { type: string }) => p.type === "text").text
      ).screen
      return calls === 2
        ? toolResponse("fill", { epoch: screen.epoch })
        : toolResponse("review", {
            epoch: screen.epoch,
            fields: [description()],
          })
    }
  )
  await assert.rejects(
    runComputerApplication(fixture.page, packet, {
      automatic: true,
      reserveDecision: async () => {},
      beforeSubmit: async (_packet, confirm) => {
        fixture.boundary()
        await confirm()
      },
    }),
    { code: "receipt_text_mismatch" }
  )
  assert.equal(fixture.submissions(), 1)
  assert.equal(calls, 4)
})

test("exhausted decision budget prevents a model call and employer submission", async (t) => {
  modelEnvironment(t)
  const fixture = browserFixture()
  t.mock.method(globalThis, "fetch", async () =>
    assert.fail("Quota exhausted: model must not be called")
  )
  await assert.rejects(
    discoverComputerForm(fixture.page, packet, async () => {
      throw new Error("Application decision quota reached")
    }),
    /quota/
  )
  assert.equal(fixture.submissions(), 0)
})

test("a required question appearing after the screenshot is refreshed and paused before submission", async (t) => {
  modelEnvironment(t)
  const fixture = browserFixture()
  let calls = 0
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, init: RequestInit) => {
      calls++
      const body = JSON.parse(String(init.body))
      const message = body.messages.find(
        (m: { role: string }) => m.role === "user"
      )
      const screen = JSON.parse(
        message.content.find((p: { type: string }) => p.type === "text").text
      ).screen
      if (calls === 2) return toolResponse("fill", { epoch: screen.epoch })
      if (calls === 3) fixture.addRequiredQuestion()
      const fields =
        calls === 4
          ? [
              description(),
              description({
                targets: ["c1"],
                label: "Salary expectation",
                kind: "number",
              }),
            ]
          : [description()]
      return toolResponse("review", { epoch: screen.epoch, fields })
    }
  )
  const result = await runComputerApplication(fixture.page, packet, {
    automatic: true,
    reserveDecision: async () => {},
    beforeSubmit: async () =>
      assert.fail("New required question must pause before submission"),
  })
  assert.equal(result.needsAnswers, true)
  assert.ok(
    result.packet.fields.some((field) => field.label === "Salary expectation")
  )
  assert.equal(fixture.submissions(), 0)
  assert.equal(calls, 4)
})

test("required Yes/No widgets cannot be omitted from a reviewed application", () => {
  const browser = observation([
    control(),
    control({
      target: "c1",
      tag: "button",
      type: "button",
      label: "Yes",
      group: "Work authorization",
      required: true,
    }),
  ])
  assert.throws(
    () => bindComputerFields(browser, 1, [description()], 0),
    /required employer question was omitted/
  )
})

for (const scenario of [
  {
    name: "unsupported field with prefilled text",
    control: control({
      id: "unknown",
      type: "text",
      label: "Additional information",
      required: false,
      value: "Employer default",
    }),
    kind: "unsupported" as const,
    label: "Additional information",
    options: [],
  },
  {
    name: "optional Yes/No control with unapproved selection",
    control: control({
      id: "optional",
      tag: "button",
      type: "button",
      label: "Yes",
      group: "Optional consent",
      required: false,
      checked: true,
    }),
    kind: "yesno" as const,
    label: "Optional consent",
    options: ["Yes"],
  },
])
  test(`${scenario.name} pauses before the submission boundary`, async (t) => {
    modelEnvironment(t)
    const fixture = browserFixture(scenario.control)
    let calls = 0
    t.mock.method(
      globalThis,
      "fetch",
      async (_url: unknown, init: RequestInit) => {
        calls++
        const body = JSON.parse(String(init.body))
        const message = body.messages.find(
          (m: { role: string }) => m.role === "user"
        )
        const screen = JSON.parse(
          message.content.find((p: { type: string }) => p.type === "text").text
        ).screen
        return calls === 1
          ? toolResponse("review", {
              epoch: screen.epoch,
              fields: [
                description({
                  label: scenario.label,
                  kind: scenario.kind,
                  required: false,
                  options: scenario.options,
                }),
              ],
            })
          : toolResponse("fill", { epoch: screen.epoch })
      }
    )
    const unapproved = {
      ...packet,
      fields: [
        {
          id: scenario.control.id,
          label: scenario.label,
          kind: scenario.kind,
          required: false,
          options: scenario.options,
          help: "",
        },
      ],
      answers: {},
    }
    await assert.rejects(
      runComputerApplication(fixture.page, unapproved, {
        automatic: true,
        reserveDecision: async () => {},
        beforeSubmit: async () =>
          assert.fail("Unapproved defaults must never reach submission"),
      }),
      /Unsupported employer control/
    )
    assert.equal(fixture.submissions(), 0)
    assert.equal(
      calls,
      4,
      "Repeated identical failures stop after three attempts"
    )
  })

for (const deterministicFill of [false, true]) {
  test(`approved stable form uses ${deterministicFill ? 2 : 4} model calls with deterministic fill ${deterministicFill}`, async (t) => {
    modelEnvironment(t)
    process.env.APPLICATION_RECEIPT_MODEL = "synthetic-receipt-model"
    const fixture = browserFixture()
    let calls = 0,
      reservations = 0
    t.mock.method(
      globalThis,
      "fetch",
      async (_url: unknown, init: RequestInit) => {
        calls++
        const body = JSON.parse(String(init.body))
        if (body.model === "synthetic-receipt-model")
          return Response.json({
            choices: [
              {
                index: 0,
                finish_reason: "stop",
                message: {
                  role: "assistant",
                  content: JSON.stringify({
                    confirmed: true,
                    text: "Thank you for applying",
                  }),
                },
              },
            ],
            usage: { prompt_tokens: 100, completion_tokens: 20 },
          })
        const message = body.messages.find(
          (m: { role: string }) => m.role === "user"
        )
        const state = JSON.parse(
          message.content.find((p: { type: string }) => p.type === "text").text
        )
        return state.phase === "fill_answers"
          ? toolResponse("fill", { epoch: state.screen.epoch })
          : toolResponse("review", {
              epoch: state.screen.epoch,
              fields: [description()],
            })
      }
    )
    const result = await runComputerApplication(fixture.page, packet, {
      automatic: true,
      deterministicFill,
      reserveDecision: async () => {
        reservations++
      },
      beforeSubmit: async (latest, confirm) => {
        assert.deepEqual(latest.answers, packet.answers)
        assert.equal(fixture.submissions(), 0)
        fixture.boundary()
        await confirm()
      },
    })
    assert.equal(result.needsAnswers, false)
    assert.equal(fixture.submissions(), 1)
    assert.equal(calls, deterministicFill ? 2 : 4)
    assert.equal(reservations, calls)
  })
}

test("deterministic fill re-reviews a required question revealed during filling and never submits it unanswered", async (t) => {
  modelEnvironment(t)
  const fixture = browserFixture()
  fixture.failNextFill(() => {
    fixture.addRequiredQuestion()
  })
  let calls = 0
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, init: RequestInit) => {
      calls++
      const body = JSON.parse(String(init.body))
      const message = body.messages.find(
        (m: { role: string }) => m.role === "user"
      )
      const state = JSON.parse(
        message.content.find((p: { type: string }) => p.type === "text").text
      )
      const fields = [description()]
      if (state.screen.controls.some((c: ComputerControl) => c.id === "salary"))
        fields.push(
          description({
            targets: ["c1"],
            label: "Salary expectation",
            kind: "number",
          })
        )
      return state.phase === "fill_answers"
        ? toolResponse("fill", { epoch: state.screen.epoch })
        : toolResponse("review", { epoch: state.screen.epoch, fields })
    }
  )
  const result = await runComputerApplication(fixture.page, packet, {
    automatic: true,
    deterministicFill: true,
    reserveDecision: async () => {},
    beforeSubmit: async () =>
      assert.fail("New required answers still need review"),
  })
  assert.equal(result.needsAnswers, true)
  assert.equal(result.packet.answers.email, packet.answers.email)
  assert.ok(result.packet.fields.some((f) => f.label === "Salary expectation"))
  assert.equal(fixture.submissions(), 0)
  assert.equal(calls, 2)
})

test("deterministic fill keeps the final value check after the asynchronous approval gate", async (t) => {
  modelEnvironment(t)
  const fixture = browserFixture()
  let calls = 0
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, init: RequestInit) => {
      calls++
      const body = JSON.parse(String(init.body))
      const message = body.messages.find(
        (m: { role: string }) => m.role === "user"
      )
      const state = JSON.parse(
        message.content.find((p: { type: string }) => p.type === "text").text
      )
      return state.phase === "fill_answers"
        ? toolResponse("fill", { epoch: state.screen.epoch })
        : toolResponse("review", {
            epoch: state.screen.epoch,
            fields: [description()],
          })
    }
  )
  await assert.rejects(
    runComputerApplication(fixture.page, packet, {
      automatic: true,
      deterministicFill: true,
      reserveDecision: async () => {},
      beforeSubmit: async (_latest, confirm) => {
        fixture.updateControl({ value: "changed@example.test" })
        fixture.boundary()
        await confirm()
      },
    }),
    /no longer matches approved answer/
  )
  assert.equal(fixture.submissions(), 0)
  assert.equal(calls, 1)
})

for (const outcome of ["solved", "expired", "answers-changed"] as const) {
  test(`a challenge after send intent is recorded ${outcome} before the first click`, async (t) => {
    modelEnvironment(t)
    const fixture = browserFixture()
    let calls = 0,
      handoffs = 0,
      gates = 0
    t.mock.method(
      globalThis,
      "fetch",
      async (_url: unknown, init: RequestInit) => {
        calls++
        if (calls === 2)
          return Response.json({
            choices: [
              {
                index: 0,
                finish_reason: "stop",
                message: {
                  role: "assistant",
                  content: JSON.stringify({
                    confirmed: true,
                    text: "Thank you for applying",
                  }),
                },
              },
            ],
            usage: { prompt_tokens: 100, completion_tokens: 20 },
          })
        const state = JSON.parse(
          JSON.parse(String(init.body))
            .messages.find((m: { role: string }) => m.role === "user")
            .content.find((p: { type: string }) => p.type === "text").text
        )
        return toolResponse("review", {
          epoch: state.screen.epoch,
          fields: [description()],
        })
      }
    )
    const result = runComputerApplication(fixture.page, packet, {
      automatic: true,
      deterministicFill: true,
      reserveDecision: async () => {},
      humanVerification: async (ready) => {
        handoffs++
        assert.equal(fixture.submissions(), 0)
        assert.equal(await ready(), false)
        if (outcome === "expired")
          throw new Error(
            "Human verification required; assistance time expired"
          )
        fixture.completeHumanVerification()
        if (outcome === "answers-changed")
          fixture.updateControl({ value: "changed@example.test" })
        assert.equal(await ready(), true)
      },
      beforeSubmit: async (_latest, confirm) => {
        gates++
        fixture.boundary()
        fixture.showChallenge()
        await confirm()
      },
    })
    if (outcome === "solved") assert.equal((await result).needsAnswers, false)
    else
      await assert.rejects(
        result,
        outcome === "expired"
          ? /assistance time expired/
          : /no longer matches approved answer/
      )
    assert.equal(handoffs, 1)
    assert.equal(gates, 1)
    assert.equal(fixture.submissions(), outcome === "solved" ? 1 : 0)
    assert.equal(calls, outcome === "solved" ? 2 : 1)
  })
}

test("a challenge revealed during deterministic fill pauses immediately without extra model calls", async (t) => {
  modelEnvironment(t)
  const fixture = browserFixture()
  fixture.failNextFill(() => {
    fixture.showChallenge()
  })
  let calls = 0
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, init: RequestInit) => {
      calls++
      const state = JSON.parse(
        JSON.parse(String(init.body))
          .messages.find((m: { role: string }) => m.role === "user")
          .content.find((p: { type: string }) => p.type === "text").text
      )
      return toolResponse("review", {
        epoch: state.screen.epoch,
        fields: [description()],
      })
    }
  )
  await assert.rejects(
    runComputerApplication(fixture.page, packet, {
      automatic: true,
      deterministicFill: true,
      reserveDecision: async () => {},
      beforeSubmit: async () => assert.fail("Human challenge blocks sending"),
    }),
    /Human verification required/
  )
  assert.equal(calls, 1)
  assert.equal(fixture.submissions(), 0)
})

for (const scenario of [
  {
    label: "Apply",
    scope: "form#application",
    enabledLate: false,
    expectedCalls: 2,
  },
  {
    label: "Apply now",
    scope: "form#application",
    enabledLate: false,
    expectedCalls: 2,
  },
  {
    label: "Apply",
    scope: "form#application",
    enabledLate: true,
    expectedCalls: 3,
  },
  { label: "Apply", scope: "body", enabledLate: false, expectedCalls: 0 },
]) {
  test(`a ${scenario.label} button in ${scenario.scope}${scenario.enabledLate ? " enabled after filling" : ""} ${scenario.scope === "body" ? "cannot authorize submission" : "submits only through the backend gate"}`, async (t) => {
    modelEnvironment(t)
    const fixture = browserFixture(
      control({ scope: scenario.scope }),
      undefined,
      {
        label: scenario.label,
        type: "button",
        scope: scenario.scope,
        disabled: scenario.enabledLate,
      }
    )
    if (scenario.enabledLate)
      fixture.failNextFill(() => {
        fixture.updateSubmit({ disabled: false })
      })
    let calls = 0,
      gates = 0
    t.mock.method(
      globalThis,
      "fetch",
      async (_url: unknown, init: RequestInit) => {
        calls++
        const body = JSON.parse(String(init.body))
        const state = JSON.parse(
          body.messages
            .find((m: { role: string }) => m.role === "user")
            .content.find((p: { type: string }) => p.type === "text").text
        )
        if (state.visibleText !== undefined)
          return Response.json({
            choices: [
              {
                index: 0,
                finish_reason: "stop",
                message: {
                  role: "assistant",
                  content: JSON.stringify({
                    confirmed: true,
                    text: "Thank you for applying",
                  }),
                },
              },
            ],
            usage: { prompt_tokens: 100, completion_tokens: 20 },
          })
        if (state.phase === "advance_or_finish")
          return toolResponse("ready", {
            epoch: state.screen.epoch,
            target: "c1",
          })
        if (state.phase === "fill_answers")
          return toolResponse("fill", { epoch: state.screen.epoch })
        return toolResponse("review", {
          epoch: state.screen.epoch,
          fields: [description()],
        })
      }
    )
    const result = runComputerApplication(fixture.page, packet, {
      automatic: true,
      deterministicFill: true,
      reserveDecision: async () => {},
      beforeSubmit: async (_latest, confirm) => {
        gates++
        assert.notEqual(
          scenario.scope,
          "body",
          "A generic Apply navigation button is not a final submit"
        )
        fixture.boundary()
        await confirm()
      },
    })
    if (scenario.scope === "body") {
      await assert.rejects(result, /Unsupported employer control/)
      assert.equal(gates, 0)
      assert.equal(fixture.submissions(), 0)
    } else {
      assert.equal((await result).needsAnswers, false)
      assert.equal(gates, 1)
      assert.equal(fixture.submissions(), 1)
      assert.equal(calls, scenario.expectedCalls)
    }
  })
}

test("Greenhouse-style searchable dropdowns survive planner slips without dropping safety checks", () => {
  const dropdown = (target: string, label: string) =>
    control({
      target,
      selector: `#${target}`,
      type: "text",
      role: "combobox",
      label,
      id: target,
      name: "",
      autocomplete: "",
    })
  const proxy = (target: string, group: string) =>
    control({
      target,
      selector: `#proxy-${target}`,
      type: "text",
      label: "",
      group,
      id: "",
      name: "",
      autocomplete: "",
    })
  const browser = observation([
    dropdown("c0", "Location (City)*"),
    proxy("c1", "Location (City)*"),
    control({
      target: "c2",
      selector: "#toggle",
      tag: "button",
      type: "button",
      label: "Toggle flyout",
      id: "",
      name: "",
      required: false,
    }),
    dropdown("c3", "Are you authorized to work?*"),
    proxy("c4", "Are you authorized to work?*"),
    control({
      target: "c5",
      selector: "#submit",
      tag: "button",
      type: "submit",
      label: "Submit application",
      id: "",
      name: "",
      required: false,
    }),
  ])
  const grounded = groundFieldDescriptions(browser, 1, [
    description({ targets: ["c0", "c1"], label: "Location", kind: "select" }),
    description({
      targets: ["c2"],
      label: "Toggle flyout",
      kind: "unsupported",
    }),
    description({ targets: ["c4", "c5"], label: "Authorized", kind: "yesno" }),
  ])
  assert.deepEqual(
    grounded.map((d) => [d.kind, d.targets]),
    [
      ["combobox", ["c0"]],
      ["combobox", ["c3"]],
    ]
  )
  assert.equal(
    validationProxy(browser.observation.controls[1], [
      browser.observation.controls[0],
    ]),
    true
  )
  assert.equal(
    validationProxy(browser.observation.controls[1], [
      browser.observation.controls[3],
    ]),
    false
  )
})

test("upload inputs labelled only by their button take the slot name from their id", () => {
  const browser = observation([
    control({
      selector: "#resume",
      type: "file",
      label: "Attach",
      group: "Attach",
      id: "resume",
      name: "",
      required: false,
      autocomplete: "",
    }),
  ])
  const [binding] = bindComputerFields(
    browser,
    1,
    [description({ label: "Resume/CV", kind: "resume", required: true })],
    0
  )
  assert.equal(binding.field.kind, "resume")
  assert.equal(binding.field.label, "Resume")
})

test("approved mappings replay only complete, uniquely grounded questions", () => {
  const browser = observation([control()])
  assert.equal(approvedFieldDescriptions(browser, packet, 0)?.length, 1)
  for (const mutation of [
    { label: "Referee email" },
    { id: "different-email", name: "different-email" },
    { required: false },
    { type: "number" },
  ]) {
    browser.observation.controls = [control(mutation)]
    assert.equal(approvedFieldDescriptions(browser, packet, 0), undefined)
  }
  browser.observation.controls = [
    control(),
    control({
      target: "c1",
      id: "extra",
      name: "extra",
      selector: "#extra",
      label: "Optional consent",
      type: "checkbox",
      required: false,
    }),
  ]
  assert.equal(
    approvedFieldDescriptions(browser, packet, 0),
    undefined,
    "Optional questions cannot be omitted"
  )
  browser.observation.controls = [
    control(),
    control({ target: "c1", selector: "#duplicate" }),
  ]
  assert.equal(
    approvedFieldDescriptions(browser, packet, 0),
    undefined,
    "Duplicate identities must not pick a first match"
  )
})

test("native mappings recover regenerated radio IDs without inventing questions", () => {
  const browser = observation([
    control({
      target: "c0",
      id: "new-prefix-one",
      name: "new-group",
      type: "radio",
      label: "Yes",
      group: "Can we contact you?",
    }),
    control({
      target: "c1",
      id: "new-prefix-two",
      name: "new-group",
      type: "radio",
      label: "No",
      group: "Can we contact you?",
    }),
  ])
  const descriptions = observedFieldDescriptions(browser, 0)
  assert.equal(descriptions?.length, 1)
  const fields = bindComputerFields(browser, 1, descriptions!, 0).map(
    (b) => b.field
  )
  assert.equal(fields[0].label, "Can we contact you?")
  assert.deepEqual(fields[0].options, ["Yes", "No"])
  browser.observation.controls.push(
    control({
      target: "c2",
      id: "unknown",
      name: "",
      label: "",
      group: "",
      type: "text",
    })
  )
  assert.equal(observedFieldDescriptions(browser, 0), undefined)
})

test("approved mapping reuse still pauses for changed employer notices", async () => {
  const f = browserFixture()
  f.setNotices("New consent: share the application with another organization")
  const result = await runComputerApplication(f.page, packet, {
    planner: "browser-use",
    reuseApprovedMapping: true,
    automatic: false,
    reserveDecision: async () =>
      assert.fail("No model needed to recognize the unchanged questions"),
    beforeSubmit: async () =>
      assert.fail("Changed notices require renewed review"),
  })
  assert.equal(result.needsAnswers, true)
  assert.match(result.packet.notices, /New consent/)
  assert.equal(f.submissions(), 0)
})

test("Browser Use startup stays bounded for a large approved application packet", async () => {
  const f = browserFixture()
  const largePacket = {
    ...packet,
    resume: "Large approved resume section. ".repeat(5000),
  }
  const unbind = bindBrowserUse(f.page.context(), async (run) => {
    assert.ok(
      run.task.length < 10_000,
      `SDK task must not contain the full packet: ${run.task.length}`
    )
    const state = (await run.execute("observe", {})) as {
      fields: unknown[]
      answers: unknown
    }
    assert.deepEqual(state.fields, largePacket.fields)
    assert.deepEqual(state.answers, largePacket.answers)
    throw new Error("bounded task verified")
  })
  try {
    await assert.rejects(
      runComputerApplication(f.page, largePacket, {
        planner: "browser-use",
        automatic: true,
        reuseApprovedMapping: false,
        reserveDecision: async () => {},
        beforeSubmit: async () =>
          assert.fail("No submission during startup test"),
      }),
      /bounded task verified/
    )
    assert.equal(f.submissions(), 0)
  } finally {
    unbind()
  }
})

test("browser document reader tolerates an iframe before its body exists", () => {
  class Document {
    title = "Loading application iframe"
    body = null
    documentElement = null
    createTreeWalker(root: unknown) {
      assert.equal(
        root,
        this,
        "A loading document still provides a valid Node root"
      )
      return { nextNode: () => null }
    }
    querySelectorAll() {
      return []
    }
  }
  const result = runInNewContext(`(${readComputerDocument.toString()})()`, {
    Document,
    ShadowRoot: class {},
    NodeFilter: { SHOW_TEXT: 4 },
    document: new Document(),
  })
  assert.equal(result.text, "")
  assert.equal(result.controls.length, 0)
})
