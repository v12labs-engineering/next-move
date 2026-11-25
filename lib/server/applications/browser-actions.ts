import type { Page, Frame, Locator } from "playwright-core"

// Callers bind the locator to a fresh observation and an approved value.
export async function performBrowserAction(
  _page: Page,
  _frame: Frame,
  locator: Locator,
  method: "click" | "fill",
  value = ""
) {
  if ((await locator.count()) !== 1)
    throw new Error("Ambiguous browser control")
  if (method === "fill") await locator.fill(value, { timeout: 12000 })
  else await locator.click({ timeout: 12000 })
}
