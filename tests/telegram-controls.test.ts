import assert from "node:assert/strict"
import test from "node:test"
import type { ApplicationField } from "../lib/applications"
import {
  actionId,
  currentQuestion,
  editCode,
  parseAction,
  questionKeyboard,
  questionMessage,
  telegramStateSchema,
  transition,
  type TelegramAction,
  type TelegramRequest,
} from "../lib/telegram"

const origin = "https://app.example.test"
function request(
  kind: ApplicationField["kind"],
  options: string[] = []
): TelegramRequest {
  return {
    id: "20000000-0000-4000-8000-000000000001",
    user_id: "00000000-0000-4000-8000-000000000001",
    application_id: "10000000-0000-4000-8000-000000000001",
    revision: 1,
    version: 2,
    expires_at: "2099-01-01T00:00:00Z",
    packet: {
      title: "Engineer",
      company: "Synthetic employer",
      resume: "A fictional candidate resume of sufficient length.",
      notices: "Employer notice",
      formHash: "fixture",
      tailored: true,
      fields: [
        {
          id: "field",
          label: "Employer question",
          help: "Help text",
          kind,
          required: true,
          options,
        },
      ],
      answers: {},
    },
    state: {
      initialized: true,
      editing: false,
      confirmed: [],
      answers: {},
      proposals: {},
    },
  }
}
function click(q: TelegramRequest, action: TelegramAction) {
  return { ...q, version: q.version + 1, state: transition(q, action).state }
}

test("Telegram select, combobox, radio and yes/no controls stage exact choices before confirmation", () => {
  for (const kind of ["select", "combobox", "radio", "yesno"] as const) {
    let q = request(kind, ["Yes, eligible", "No – require sponsorship"])
    const prompt = questionMessage(q, origin)
    assert.match(prompt.text, /Type: .*Required/)
    assert.match(prompt.text, /1\. Yes, eligible/)
    assert.equal(prompt.forceReply, false)
    assert.deepEqual(
      prompt.buttons.slice(0, 2).map((row) => row[0].action),
      ["choose:0", "choose:1"]
    )
    q = click(q, "choose:1")
    assert.equal(q.state.answers.field, "No – require sponsorship")
    assert.deepEqual(q.state.confirmed, [])
    assert.equal(currentQuestion(q)?.id, "field")
    assert.throws(() => transition(q, "send"), /confirm every/)
    assert.match(questionMessage(q, origin).buttons[1][0].label, /^●/)
    q = click(q, "choose:0")
    assert.equal(
      q.state.answers.field,
      "Yes, eligible",
      "A new single choice replaces the previous choice"
    )
    q = click(q, "confirm")
    assert.equal(currentQuestion(q), undefined)
    assert.equal(transition(q, "send").finish, true)
    assert.deepEqual(
      q.packet.answers,
      {},
      "Choice drafts never mutate the employer packet"
    )
  }
  const q = click(request("yesno"), "choose:1")
  assert.equal(q.state.answers.field, "No")
})

test("Telegram checkbox choices toggle independently and an empty required selection cannot confirm", () => {
  let q = request("checkbox", ["Engineering", "Research", "Operations"])
  q = click(click(q, "choose:1"), "choose:0")
  assert.deepEqual(q.state.answers.field, ["Engineering", "Research"])
  const buttons = questionMessage(q, origin).buttons.flat()
  assert.match(buttons[0].label, /^☑/)
  assert.match(buttons[1].label, /^☑/)
  assert.match(buttons[2].label, /^☐/)
  q = click(click(q, "choose:0"), "choose:1")
  assert.deepEqual(q.state.answers.field, [])
  assert.throws(() => transition(q, "confirm"), /before confirming/)
  assert.ok(
    !questionMessage(q, origin)
      .buttons.flat()
      .some((b) => b.action === "confirm")
  )
  q = click(click(q, "choose:2"), "confirm")
  assert.deepEqual(q.state.answers.field, ["Operations"])
  assert.equal(currentQuestion(q), undefined)
})

test("Telegram paginates all 500 choices and preserves checkbox drafts across pages", () => {
  let q = request(
    "checkbox",
    Array.from({ length: 500 }, (_, i) => `Choice ${i + 1}`)
  )
  const prompt = questionMessage(q, origin)
  assert.match(prompt.text, /Choices 1–8 of 500/)
  assert.equal(
    prompt.buttons.filter((row) => row[0].action.startsWith("choose:")).length,
    8
  )
  assert.throws(() => transition(q, "choose:8"), /latest question/)
  q = click(click(q, "choose:0"), "page:1")
  assert.match(questionMessage(q, origin).text, /Choices 9–16 of 500/)
  assert.deepEqual(q.state.answers.field, ["Choice 1"])
  q = click(q, "choose:8")
  q = {
    ...q,
    state: telegramStateSchema.parse(JSON.parse(JSON.stringify(q.state))),
  }
  assert.equal(
    q.state.choicePage,
    1,
    "The existing JSON review state persists the current page"
  )
  q = click(click(q, "page:62"), "choose:499")
  assert.match(questionMessage(q, origin).text, /Choices 497–500 of 500/)
  assert.deepEqual(q.state.answers.field, [
    "Choice 1",
    "Choice 9",
    "Choice 500",
  ])
  assert.ok(
    !questionMessage(q, origin)
      .buttons.flat()
      .some((b) => b.action === "page:63")
  )
  assert.throws(() => transition(q, "page:63"), /unavailable/)
  assert.throws(() => transition(q, "choose:500"), /latest question/)
  q = click(q, "confirm")
  assert.equal(q.state.choicePage, undefined)
})

test("Telegram page state resets for the next question and legacy editing states still offer choices", () => {
  let q = request(
    "select",
    Array.from({ length: 10 }, (_, i) => `Choice ${i + 1}`)
  )
  q.packet.fields.push({ ...q.packet.fields[0], id: "next" })
  q.state.editing = true
  assert.equal(questionMessage(q, origin).forceReply, false)
  assert.ok(
    questionMessage(q, origin)
      .buttons.flat()
      .some((b) => b.action === "choose:0")
  )
  q = click(click(click(q, "page:1"), "choose:9"), "confirm")
  assert.equal(currentQuestion(q)?.id, "next")
  assert.equal(q.state.choicePage, undefined)
  assert.match(questionMessage(q, origin).text, /Choices 1–8 of 10/)
})

test("Telegram keeps long option values exact and binds keyboard callbacks to the saved version", () => {
  const option = "🔬 Research, engineering & product – ".repeat(20).trim()
  const q = { ...request("select", [option]), version: 2147483647 }
  const prompt = questionMessage(q, origin)
  assert.ok(prompt.text.includes(option))
  assert.ok(Array.from(prompt.buttons[0][0].label).length < 70)
  const keyboard = questionKeyboard(q, prompt)
  for (const button of keyboard.flat()) {
    assert.ok(Buffer.byteLength(button.callback_data) <= 64)
    const action = parseAction(button.callback_data)!
    assert.equal(action.id, q.id)
    assert.equal(action.version, q.version)
  }
  assert.equal(click(q, "choose:0").state.answers.field, option)
  for (const action of [
    "choose:-1",
    "choose:1.5",
    "choose:1:send",
    "page:-1",
    "page:1x",
  ]) {
    assert.equal(parseAction(`tg:${q.id}:2:${action}`), null)
  }
  assert.equal(parseAction(`tg:${q.id}:9007199254740993:choose:0`), null)
  assert.notEqual(
    actionId(q, "choose:0"),
    actionId({ ...q, version: 2 }, "choose:0")
  )
})

test("Telegram text controls show type-specific reply instructions and preserve validation", () => {
  const cases = [
    ["text", "Text", "An answer"],
    ["textarea", "multiple lines", "First line\nSecond line"],
    ["number", "Enter a number", "30"],
    ["email", "email address", "candidate@example.test"],
    ["tel", "country code", "+1234567890"],
    ["url", "complete URL", "https://example.test/profile"],
  ] as const
  for (const [kind, instruction, value] of cases) {
    let q = click(request(kind), "edit")
    const prompt = questionMessage(q, origin)
    assert.ok(prompt.text.includes(instruction))
    assert.ok(prompt.text.includes(`${editCode(q)}:`))
    assert.equal(prompt.forceReply, true)
    assert.deepEqual(prompt.buttons, [])
    assert.throws(
      () => transition(q, "confirm", `old-turn:${value}`),
      /Reply with/
    )
    q = {
      ...q,
      state: transition(q, "confirm", `${editCode(q)}:${value}`).state,
    }
    assert.equal(q.state.answers.field, value)
    assert.deepEqual(q.state.confirmed, [])
    assert.equal(currentQuestion(q)?.id, "field")
  }
  for (const kind of ["text", "number", "unsupported"] as const) {
    assert.throws(
      () => transition(request(kind), "choose:0"),
      /latest question|application in the app/
    )
  }
})

test("Telegram proposals stay available beside choice buttons and toggling does not confirm them", () => {
  let q = request("checkbox", ["A", "B"])
  q.state.proposals.field = { answer: ["A"], source: "Your saved answer" }
  assert.ok(
    questionMessage(q, origin)
      .buttons.flat()
      .some((b) => b.action === "use")
  )
  q = click(click(q, "choose:1"), "choose:1")
  const prompt = questionMessage(q, origin)
  assert.match(prompt.text, /No choices selected yet/)
  assert.ok(
    !prompt.buttons
      .flat()
      .some((b) => b.action === "confirm" || b.action === "use")
  )
  assert.deepEqual(q.state.confirmed, [])
  const blank = request("select", ["A", "B"])
  blank.state.answers.field = ""
  blank.state.proposals.field = { answer: "A", source: "Your saved answer" }
  assert.ok(
    questionMessage(blank, origin)
      .buttons.flat()
      .some((b) => b.action === "use")
  )
})
