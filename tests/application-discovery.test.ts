import assert from "node:assert/strict"
import test from "node:test"
import type { Page } from "playwright-core"
import {
  ApplicationNavigation,
  openApplication,
  readNavigationDocument,
} from "../lib/server/applications/discovery"
import { readNativeForm } from "../lib/server/applications/forms"
import { readAshbyForm } from "../lib/server/applications/ashby"

const candidate = { title: "Backend engineer", company: "Example employer" }
type DocumentFixture = {
  form?: boolean
  ashby?: boolean
  hidden?: boolean
  choices: { label: string; href: string | null; target?: string }[]
}
function browser(
  documents: Record<string, DocumentFixture>,
  start: string,
  embedded: DocumentFixture[] = []
) {
  let url = start,
    clicks = 0,
    disposed = 0
  const frame = (fixture: () => DocumentFixture, child = false) => ({
    parentFrame: () => (child ? {} : null),
    frameElement: async () => ({
      isVisible: async () => !fixture().hidden,
      dispose: async () => {
        disposed++
      },
    }),
    evaluate: async (fn: unknown) => {
      if (fn === readAshbyForm && fixture().ashby)
        return {
          fields: [
            {
              id: "email",
              label: "Email",
              kind: "email",
              required: true,
              options: [],
            },
          ],
          notices: "",
        }
      if (fn === readNativeForm) {
        if (!fixture().form) throw Error("Application form not found")
        return {
          fields: [{ id: "email", label: "Email", kind: "email" }],
          notices: "",
        }
      }
      if (fn === readNavigationDocument)
        return {
          title: "Backend engineer",
          heading: "Example employer",
          choices: fixture().choices.map((c, index) => ({
            ...c,
            index,
            target: c.target || "",
            visible: true,
          })),
        }
      return url
    },
    locator: (selector: string) => ({
      count: async () =>
        Number(
          selector === ".ashby-application-form-container" && !!fixture().ashby
        ),
      nth: (index: number) => ({
        evaluate: async () => ({
          label: fixture().choices[index].label,
          href: fixture().choices[index].href,
        }),
        click: async () => {
          const choice = fixture().choices[index]
          clicks++
          if (choice.href) url = choice.href
        },
      }),
    }),
  })
  const main = frame(() => documents[url])
  const children = embedded.map((doc) => frame(() => doc, true))
  const page = {
    ...main,
    frames: () => [main, ...children],
    goto: async (next: string) => {
      if (!documents[next]) throw Error("Unexpected destination")
      url = next
      clicks++
    },
    waitForFunction: async () => {},
  } as unknown as Page
  return {
    page,
    main,
    children,
    url: () => url,
    clicks: () => clicks,
    disposed: () => disposed,
  }
}

test("one action discovers a form through an unrelated employer domain without a vendor adapter or AI call", async () => {
  const source = "https://careers.example.com/engineering/role-123"
  const destination = "https://recruitment.anothercompany.org/apply?id=123"
  const b = browser(
    {
      [source]: {
        choices: [
          { label: "Apply for this job", href: destination, target: "_blank" },
        ],
      },
      [destination]: { form: true, choices: [] },
    },
    source
  )
  const surface = await openApplication(b.page, candidate, async () =>
    assert.fail("Unambiguous Apply does not need AI")
  )
  assert.equal(surface, b.main)
  assert.equal(b.url(), destination)
  assert.equal(b.clicks(), 1)
})

test("visible embedded application forms are discovered; hidden tracking frames are skipped", async () => {
  const source = "https://careers.example.com/job/1"
  const b = browser({ [source]: { choices: [] } }, source, [
    { form: true, hidden: true, choices: [] },
    { form: true, choices: [] },
  ])
  assert.equal(
    await openApplication(b.page, candidate, async () =>
      assert.fail("Form already present")
    ),
    b.children[1]
  )
  assert.equal(b.clicks(), 0)
  assert.equal(b.disposed(), 2)
})

test("an already open Ashby form is recognized before clicking its current Application tab", async () => {
  const source = "https://jobs.ashbyhq.com/example/123/application"
  const b = browser(
    {
      [source]: {
        ashby: true,
        choices: [{ label: "Application", href: source }],
      },
    },
    source
  )
  const navigation = new ApplicationNavigation(b.page)
  assert.equal((await navigation.inspect()).ready, true)
  assert.equal(
    await openApplication(b.page, candidate, async () =>
      assert.fail("Visible form needs no AI")
    ),
    b.main
  )
  assert.equal(b.clicks(), 0)
})

test("visible embedded Ashby forms use the same reader as preparation", async () => {
  const source = "https://careers.example.com/job/1"
  const b = browser({ [source]: { choices: [] } }, source, [
    { ashby: true, hidden: true, choices: [] },
    { ashby: true, choices: [] },
  ])
  assert.equal(
    await openApplication(b.page, candidate, async () =>
      assert.fail("Embedded form needs no AI")
    ),
    b.children[1]
  )
  assert.equal(b.clicks(), 0)
})

test("agent navigation can only select a current observed control, never an invented URL", async () => {
  const source = "https://careers.example.com/job/1",
    destination = "https://hiring.example.org/job/1/apply"
  const b = browser(
    {
      [source]: {
        choices: [
          { label: "Start application", href: destination, target: "_blank" },
          { label: "Team details", href: "https://careers.example.com/team" },
        ],
      },
      [destination]: { form: true, choices: [] },
    },
    source
  )
  const nav = new ApplicationNavigation(b.page)
  const observation = await nav.inspect()
  await assert.rejects(nav.open(observation.epoch, 99), /Invalid/)
  await assert.rejects(nav.open(observation.epoch - 1, 0), /Stale/)
  const result = await nav.open(observation.epoch, 0)
  assert.equal(result.ready, true)
  assert.equal(b.clicks(), 1)
})

test("changed links are rejected and discovery cannot submit, accept terms or create accounts", async () => {
  const source = "https://careers.example.com/job/1"
  const document: DocumentFixture = {
    choices: [
      { label: "Apply", href: "https://hiring.example.org/job/1" },
      { label: "Submit application", href: null },
      { label: "Accept terms", href: null },
      { label: "Create account", href: null },
      { label: "Login", href: null },
      { label: "Internal service", href: "https://169.254.169.254/latest" },
    ],
  }
  const b = browser({ [source]: document }, source)
  const nav = new ApplicationNavigation(b.page)
  const observation = await nav.inspect()
  assert.equal(observation.choices.length, 1)
  document.choices[0].href = "https://unobserved.example.net/collect"
  await assert.rejects(nav.open(observation.epoch, 0), /changed/)
  assert.equal(b.clicks(), 0)
})

test("navigation loops have a hard click budget", async () => {
  const source = "https://careers.example.com/job/1"
  const b = browser(
    {
      [source]: {
        choices: [{ label: "Apply", href: source, target: "_blank" }],
      },
    },
    source
  )
  const nav = new ApplicationNavigation(b.page)
  let state = await nav.inspect()
  for (let n = 0; n < 6; n++) state = await nav.open(state.epoch, 0)
  await assert.rejects(nav.open(state.epoch, 0), /budget/)
  assert.equal(b.clicks(), 6)
})

test("ambiguous entry uses the actual AI SDK tool loop and reserves quota before the provider call", async (t) => {
  const config = {
    TAILORING_BASE_URL: "https://provider.example/v1",
    TAILORING_MODEL: "test-model",
    TAILORING_API_KEY: "test-key",
    TAILORING_REASONING: "none",
  }
  const previous = Object.fromEntries(
    Object.keys(config).map((key) => [key, process.env[key]])
  )
  Object.assign(process.env, config)
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
  const source = "https://careers.example.com/job/1",
    destination = "https://hiring.example.org/applicant/123"
  const b = browser(
    {
      [source]: {
        choices: [
          { label: "Start your journey", href: destination, target: "_blank" },
          { label: "Meet the team", href: "https://careers.example.com/team" },
        ],
      },
      [destination]: { form: true, choices: [] },
    },
    source
  )
  let reservations = 0,
    calls = 0
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, init: RequestInit) => {
      assert.equal(reservations, 1)
      calls++
      const body = JSON.parse(String(init.body))
      assert.equal(body.reasoning_effort, "none")
      assert.equal(body.max_tokens, 700)
      assert.equal(body.tools[0].function.name, "open")
      assert.equal(
        body.messages.some(
          (m: { content: string }) =>
            typeof m.content === "string" &&
            m.content.includes("Test Candidate")
        ),
        false
      )
      return Response.json({
        id: "navigation",
        object: "chat.completion",
        created: 0,
        model: "test-model",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call-1",
                  type: "function",
                  function: {
                    name: "open",
                    arguments: JSON.stringify({ epoch: 1, id: 0 }),
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      })
    }
  )
  const surface = await openApplication(b.page, candidate, async () => {
    reservations++
  })
  assert.equal(surface, b.main)
  assert.equal(calls, 1)
  assert.equal(reservations, 1)
  assert.equal(b.clicks(), 1)
})
