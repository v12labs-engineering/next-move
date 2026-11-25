import { z } from "zod"
import { HttpError } from "@/lib/server/http"
import { telegramConfig } from "./config"

type Method =
  | "getMe"
  | "setWebhook"
  | "getWebhookInfo"
  | "sendMessage"
  | "answerCallbackQuery"
  | "setMyCommands"
export async function telegramApi<T>(
  method: Method,
  body: object,
  schema: z.ZodType<T>,
  transport: typeof fetch = fetch
): Promise<T> {
  const { token } = telegramConfig()
  let response: Response
  try {
    response = await transport(
      `https://api.telegram.org/bot${token}/${method}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
        redirect: "error",
      }
    )
  } catch {
    throw new HttpError(503, "Telegram is temporarily unavailable.")
  }
  const data = await response.json().catch(() => null)
  if (!response.ok || !data?.ok)
    throw new HttpError(503, "Telegram could not complete the request.")
  // Never expose raw Telegram descriptions/errors: URLs contain the bot token.
  return schema.parse(data.result)
}
export function chatId(thread: string) {
  if (!/^telegram:[1-9][0-9]*$/.test(thread))
    throw new Error("Invalid Telegram destination")
  return thread.slice("telegram:".length)
}
export function splitTelegramText(text: string) {
  const characters = Array.from(text)
  const chunks: string[] = []
  // Stay within Telegram's 4096-character limit, including astral Unicode.
  for (let i = 0; i < characters.length; i += 2000)
    chunks.push(characters.slice(i, i + 2000).join(""))
  return chunks.length ? chunks : ["Application review"]
}
export type TelegramButton = { text: string } & (
  | { callback_data: string; url?: never }
  | { url: string; callback_data?: never }
)
export async function sendTelegram(
  thread: string,
  text: string,
  buttons: TelegramButton[] | TelegramButton[][] = [],
  forceReply = false,
  protectContent = false
) {
  const chunks = splitTelegramText(text)
  let messageId = ""
  for (const [index, chunk] of chunks.entries()) {
    const last = index === chunks.length - 1
    const result = await telegramApi(
      "sendMessage",
      {
        chat_id: chatId(thread),
        text: chunk,
        link_preview_options: { is_disabled: true },
        ...(protectContent || buttons.flat().some((button) => "url" in button)
          ? { protect_content: true }
          : {}),
        ...(last && buttons.length
          ? {
              reply_markup: {
                inline_keyboard: Array.isArray(buttons[0])
                  ? buttons
                  : [buttons],
              },
            }
          : last && forceReply
            ? { reply_markup: { force_reply: true, selective: true } }
            : {}),
      },
      z.object({ message_id: z.number().int() })
    )
    messageId = String(result.message_id)
  }
  return messageId
}
