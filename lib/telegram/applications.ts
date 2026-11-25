import { z } from "zod"

export type ApplicationTelegramAction =
  | "review"
  | "retry"
  | "browser"
  | "status"
export function applicationTelegramAction(
  id: string,
  revision: number,
  action: ApplicationTelegramAction
) {
  return `app:${id}:${revision}:${action}`
}
export function parseApplicationTelegramAction(value: string) {
  const match =
    /^app:([a-f0-9-]{36}):([1-9][0-9]*):(review|retry|browser|status)$/.exec(
      value
    )
  if (
    !match ||
    !z.uuid().safeParse(match[1]).success ||
    !Number.isSafeInteger(Number(match[2]))
  )
    return null
  return {
    id: match[1],
    revision: Number(match[2]),
    action: match[3] as ApplicationTelegramAction,
  }
}
