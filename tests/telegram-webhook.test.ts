import assert from "node:assert/strict"
import test from "node:test"
import { z } from "zod"
import { verifyTelegramWebhook } from "../lib/server/telegram/config"
import {
  privateTelegramEvent,
  telegramUpdateSchema,
} from "../lib/server/telegram/bot"
import { sendTelegram, telegramApi } from "../lib/server/telegram/api"
import { actionId } from "../lib/telegram"

test("Telegram authenticates webhook requests and binds private messages and callbacks to their sender", () => {
  const secret = "synthetic-webhook-secret-01234567890123"
  assert.throws(
    () =>
      verifyTelegramWebhook(
        new Request("https://app.example.test", { method: "POST" }),
        secret
      ),
    /Unauthorized/
  )
  assert.throws(
    () =>
      verifyTelegramWebhook(
        new Request("https://app.example.test", {
          method: "POST",
          headers: { "x-telegram-bot-api-secret-token": "wrong" },
        }),
        secret
      ),
    /Unauthorized/
  )
  assert.doesNotThrow(() =>
    verifyTelegramWebhook(
      new Request("https://app.example.test", {
        method: "POST",
        headers: { "x-telegram-bot-api-secret-token": secret },
      }),
      secret
    )
  )
  const message = {
    message_id: 9,
    date: 1793590000,
    from: { id: 42, is_bot: false },
    chat: { id: 42, type: "private" },
    text: "/start fixture",
  }
  const parsed = privateTelegramEvent(
    telegramUpdateSchema.parse({ update_id: 123, message })
  )!
  assert.equal(parsed.thread, "telegram:42")
  assert.equal(parsed.messageId, "update:123")
  assert.equal(parsed.text, "/start fixture")
  assert.equal(
    privateTelegramEvent({
      update_id: 124,
      message: { ...message, chat: { id: -42, type: "group" } },
    }),
    null
  )
  assert.equal(
    privateTelegramEvent({
      update_id: 124,
      message: { ...message, from: { id: 43 } },
    }),
    null
  )
  const callback = privateTelegramEvent({
    update_id: 125,
    callback_query: {
      id: "click",
      from: { id: 42 },
      data: "tg:fixture",
      message: { ...message, from: { id: 99, is_bot: true } },
    },
  })!
  assert.equal(callback.thread, "telegram:42")
  assert.equal(
    callback.messageId,
    "update:125",
    "Incoming update ID, not outgoing message ID, prevents replay"
  )
  assert.equal(callback.action, "tg:fixture")
})

test("Telegram sends exact long text and revision-bound buttons; provider errors never expose the token", async (t) => {
  const env = {
    TELEGRAM_ENABLED: "true",
    TELEGRAM_BOT_TOKEN: "123456:synthetic_token",
    TELEGRAM_BOT_USERNAME: "synthetic_test_bot",
    TELEGRAM_APP_ORIGIN: "https://app.example.test",
    TELEGRAM_WEBHOOK_SECRET: "synthetic-webhook-secret-01234567890123",
  }
  const previous = Object.fromEntries(
    Object.keys(env).map((key) => [key, process.env[key]])
  )
  Object.assign(process.env, env)
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
  const sent: {
    text: string
    chat_id: string
    reply_markup?: {
      inline_keyboard?: { text: string; callback_data: string }[][]
      force_reply?: boolean
    }
  }[] = []
  t.mock.method(
    globalThis,
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      assert.equal(
        String(input),
        "https://api.telegram.org/bot123456:synthetic_token/sendMessage"
      )
      sent.push(JSON.parse(String(init?.body)))
      return Response.json({ ok: true, result: { message_id: sent.length } })
    }
  )
  const text = "Exact résumé evidence 🔔. ".repeat(300)
  const callback = actionId(
    { id: "20000000-0000-4000-8000-000000000001", version: 2 },
    "use"
  )
  assert.ok(Buffer.byteLength(callback) <= 64)
  await sendTelegram("telegram:42", text, [
    { text: "Use answer", callback_data: callback },
  ])
  assert.equal(sent.map((s) => s.text).join(""), text)
  assert.ok(sent.every((s) => s.text.length <= 4096 && s.chat_id === "42"))
  assert.equal(
    sent.at(-1)?.reply_markup?.inline_keyboard?.[0][0].callback_data,
    callback
  )
  const rows = [
    [
      {
        text: "○ Choice A",
        callback_data: actionId(
          { id: "20000000-0000-4000-8000-000000000001", version: 3 },
          "choose:0"
        ),
      },
    ],
    [
      {
        text: "○ Choice B",
        callback_data: actionId(
          { id: "20000000-0000-4000-8000-000000000001", version: 3 },
          "choose:1"
        ),
      },
    ],
    [
      {
        text: "Previous",
        callback_data: actionId(
          { id: "20000000-0000-4000-8000-000000000001", version: 3 },
          "page:0"
        ),
      },
      {
        text: "More",
        callback_data: actionId(
          { id: "20000000-0000-4000-8000-000000000001", version: 3 },
          "page:2"
        ),
      },
    ],
  ]
  const before = sent.length
  await sendTelegram("telegram:42", text, rows)
  const choiceMessages = sent.slice(before)
  assert.equal(choiceMessages.map((s) => s.text).join(""), text)
  assert.ok(choiceMessages.slice(0, -1).every((s) => !s.reply_markup))
  assert.deepEqual(choiceMessages.at(-1)?.reply_markup?.inline_keyboard, rows)
  await sendTelegram("telegram:42", "Reply to edit", [], true)
  assert.equal(sent.at(-1)?.reply_markup?.force_reply, true)
  await assert.rejects(
    sendTelegram("telegram:-1", "Do not send"),
    /Invalid Telegram/
  )
  await assert.rejects(
    telegramApi("getMe", {}, z.unknown(), async () =>
      Response.json(
        { ok: false, description: env.TELEGRAM_BOT_TOKEN },
        { status: 401 }
      )
    ),
    (error) => {
      assert.doesNotMatch(String(error), /synthetic_token/)
      return true
    }
  )
})
