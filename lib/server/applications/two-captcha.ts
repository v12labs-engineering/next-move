import { z } from "zod"
import type { Page } from "playwright-core"
import {
  applyVerificationResponse,
  readVerificationView,
  type VerificationView,
} from "./verification-surface"
import { waitForBrowserbaseCaptchaIdle } from "./captcha"

// Live grids can take several worker rounds. The send planner reserves this
// entire window separately from human help and final receipt confirmation.
export const TWO_CAPTCHA_WAIT_MS = 240_000
const MAX_GRID_TASKS = 6
const attempted = new WeakSet<Page>()
const responseSchema = z.object({
  errorId: z.number().int(),
  taskId: z.number().int().positive().optional(),
  status: z.enum(["processing", "ready"]).optional(),
  solution: z
    .object({
      click: z.union([
        z.array(z.number().int().positive()).max(16),
        z.literal("No_matching_images"),
      ]),
    })
    .optional(),
})
type Grid = {
  view: VerificationView
  selector: string
  instructions: string
  rows: number
  columns: number
  tiles: { selector: string; image: string; selected: boolean }[]
  image: Buffer
  imageType?: "recaptcha"
}

class UnsolvableGridError extends Error {
  constructor() {
    super("2Captcha could not solve challenge")
  }
}

// Request a new puzzle using an observed control inside the trusted CAPTCHA
// frame. Never reload the employer form or discard its inputs and uploads.
async function refreshRecaptchaGrid(
  page: Page,
  grid: Grid,
  ready: () => Promise<boolean>,
  until: number
) {
  await waitForBrowserbaseCaptchaIdle(page, until)
  if (await ready()) return true
  const view = await readVerificationView(page)
  if (view.frame !== grid.view.frame || view.url !== grid.view.url) return false
  const reloads = view.targets
    .map((target, index) => ({ target, index }))
    .filter(
      ({ target }) =>
        !target.tile &&
        target.kind === "click" &&
        /^(?:get a new challenge|reload(?: (?:captcha|challenge))?|refresh(?: (?:captcha|challenge))?|new challenge)$/i.test(
          target.label
        )
    )
  if (reloads.length !== 1) return false
  const previous = await readRecaptchaGrid(view, false)
  if (!previous) return false
  await applyVerificationResponse(
    page,
    view,
    { action: "click", target: reloads[0].index },
    until
  )
  const ends = Math.min(until, Date.now() + 5000)
  while (Date.now() < ends) {
    if (await ready()) return true
    const next = await readRecaptchaGrid(
      await readVerificationView(page, false, false),
      false
    )
    if (
      next &&
      (next.instructions !== previous.instructions ||
        next.rows !== previous.rows ||
        next.columns !== previous.columns ||
        next.tiles.some(
          (tile, index) => tile.image !== previous.tiles[index]?.image
        ))
    )
      return true
    await page.waitForTimeout(Math.min(250, ends - Date.now()))
  }
  return false
}

// Only the recognized reCAPTCHA frame's grid and instructions leave the browser.
// No application screenshot, candidate answers, cookies or connection URL is sent.
export async function readRecaptchaGrid(
  view: VerificationView,
  captureImage = true
): Promise<Grid | null> {
  const url = new URL(view.url)
  if (
    view.mode !== "challenge" ||
    url.protocol !== "https:" ||
    !["www.google.com", "www.recaptcha.net", "recaptcha.net"].includes(
      url.hostname
    ) ||
    !/^\/recaptcha\/(?:api2|enterprise)\/bframe$/.test(url.pathname)
  )
    return null
  const selectors = view.targets.filter((t) => t.tile).map((t) => t.selector)
  if (![9, 16].includes(selectors.length)) return null
  const data = await view.frame.evaluate(
    ({ selectors, captureImage }) => {
      const tiles = selectors.map((s) => document.querySelector(s))
      const table = tiles[0]?.closest("table")
      const instructions = document
        .querySelector<HTMLElement>(".rc-imageselect-desc-wrapper")
        ?.innerText.replace(/\s+/g, " ")
        .trim()
      if (
        !table ||
        !instructions ||
        instructions.length > 1000 ||
        tiles.some((t) => !t || t.closest("table") !== table)
      )
        return null
      const rows = table.querySelectorAll("tr").length
      const columns = rows && tiles.length / rows
      const box = table.getBoundingClientRect()
      if (
        ![3, 4].includes(rows) ||
        columns !== rows ||
        box.width <= 0 ||
        box.height <= 0 ||
        box.width > 1000 ||
        box.height > 1000
      )
        return null
      const images = tiles.map((t) => Array.from(t!.querySelectorAll("img")))
      if (
        images.some(
          (imgs) =>
            !imgs.length ||
            imgs.some((img) => !img.complete || !img.naturalWidth)
        )
      )
        return null
      const parts: string[] = []
      for (let el: Element | null = table; el; el = el.parentElement) {
        const siblings = Array.from(el.parentElement?.children || []).filter(
          (n) => n.tagName === el!.tagName
        )
        parts.unshift(
          `${el.tagName.toLowerCase()}:nth-of-type(${Math.max(0, siblings.indexOf(el)) + 1})`
        )
      }
      // 2Captcha's reCAPTCHA recognition pipeline requires original image pixels,
      // not a screenshot with borders/selection marks. Compose dynamic 3x3 tiles
      // over the original sprite; a 4x4 challenge is a single shared sprite.
      let originalImage: string | undefined
      if (
        captureImage &&
        /^select all (?:images|squares)\b/i.test(instructions) &&
        images.every((imgs) => imgs.length === 1)
      ) {
        try {
          const parts = images.map((imgs) => imgs[0])
          const base = parts.find((img) =>
            img.matches(rows === 3 ? ".rc-image-tile-33" : ".rc-image-tile-44")
          )
          const side =
            base?.naturalWidth || (rows === 3 ? parts[0].naturalWidth * 3 : 0)
          const source = base && (base.currentSrc || base.src)
          if (
            side > 0 &&
            side <= 1000 &&
            (!base || base.naturalHeight === side) &&
            parts.every(
              (img) =>
                (rows === 3 &&
                  img.matches(".rc-image-tile-11") &&
                  img.naturalWidth === side / 3 &&
                  img.naturalHeight === side / 3) ||
                (img.matches(
                  rows === 3 ? ".rc-image-tile-33" : ".rc-image-tile-44"
                ) &&
                  (img.currentSrc || img.src) === source &&
                  img.naturalWidth === side &&
                  img.naturalHeight === side)
            )
          ) {
            const canvas = document.createElement("canvas")
            canvas.width = side
            canvas.height = side
            const ctx = canvas.getContext("2d")
            if (ctx) {
              if (base) ctx.drawImage(base, 0, 0)
              if (rows === 3)
                for (const [i, img] of parts.entries()) {
                  if (img.matches(".rc-image-tile-11"))
                    ctx.drawImage(
                      img,
                      ((i % 3) * side) / 3,
                      (Math.floor(i / 3) * side) / 3
                    )
                }
              originalImage = canvas.toDataURL("image/jpeg", 0.9).split(",")[1]
            }
          }
        } catch {
          // Unreadable/cross-origin pixels keep the general screenshot path.
        }
      }
      return {
        originalImage,
        selector: parts.join(" > "),
        instructions,
        rows,
        columns,
        tiles: tiles.map((tile, i) => ({
          selector: selectors[i],
          image: JSON.stringify(
            images[i].map((img) => [
              img.currentSrc || img.src,
              img.getAttribute("style"),
              img.naturalWidth,
              img.naturalHeight,
            ])
          ),
          selected:
            tile!.matches(".rc-imageselect-tileselected") ||
            !!tile!.querySelector(".rc-imageselect-tileselected"),
        })),
      }
    },
    { selectors, captureImage }
  )
  if (!data) return null
  const { originalImage, ...structure } = data
  const image = !captureImage
    ? Buffer.alloc(0)
    : originalImage
      ? Buffer.from(originalImage, "base64")
      : await view.frame.locator(data.selector).screenshot({
          type: "png",
          scale: "css",
          animations: "disabled",
          timeout: 5000,
        })
  if (image.length > 600_000) return null
  return {
    ...structure,
    image,
    view,
    ...(originalImage ? { imageType: "recaptcha" as const } : {}),
  }
}

// A lost create response is never retried: it could already have created a paid
// task. Polling and all challenge rounds share one deadline and six-task cap.
async function solveGrid(
  grid: Grid,
  key: string,
  page: Page,
  ready: () => Promise<boolean>,
  until: number,
  phase: (value: string) => void,
  reserveTask: () => void
) {
  const call = async (method: "createTask" | "getTaskResult", data: object) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      phase(method === "createTask" ? "create_task" : "poll_result")
      const remaining = until - Date.now()
      if (remaining <= 0) throw new Error("2Captcha time budget exceeded")
      if (method === "createTask") reserveTask()
      console.info("Application CAPTCHA provider request", {
        provider: "2captcha",
        method,
        phase: "started",
        attempt: attempt + 1,
      })
      // A transport exception or malformed response is ambiguous: never retry
      // it. Explicit transient HTTP responses get bounded recovery instead.
      const response = await fetch(`https://api.2captcha.com/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientKey: key, ...data }),
        redirect: "error",
        signal: AbortSignal.timeout(Math.min(10_000, remaining)),
      })
      if (!response.ok) {
        console.info("Application CAPTCHA provider request", {
          provider: "2captcha",
          method,
          status: response.status,
          // Correlate provider edge failures without logging keys, response
          // bodies, challenge images or application data.
          edgeRequestId: /^[a-f0-9]{16}-[a-z]{3}$/i.test(
            response.headers.get("cf-ray") || ""
          )
            ? response.headers.get("cf-ray")
            : undefined,
          responseType: response.headers.get("content-type")?.includes("json")
            ? "json"
            : response.headers.get("content-type")?.includes("html")
              ? "html"
              : "other",
        })
        await response.body?.cancel()
        if (
          attempt < 2 &&
          [500, 502, 503, 504, 520, 521, 522, 523, 524].includes(
            response.status
          )
        ) {
          if (until - Date.now() <= 5000)
            throw new Error("2Captcha time budget exceeded")
          await page.waitForTimeout(5000)
          continue
        }
        throw new Error("2Captcha unavailable")
      }
      const result = responseSchema.parse(await response.json())
      console.info("Application CAPTCHA provider result", {
        provider: "2captcha",
        method,
        errorId: result.errorId,
        status: result.status ?? (result.taskId ? "created" : "unknown"),
      })
      // Only an explicit terminal failure of an existing task permits a new
      // puzzle. Lost creates, bad keys, empty balances and unknown errors stop.
      if (method === "getTaskResult" && result.errorId === 12)
        throw new UnsolvableGridError()
      if (result.errorId !== 0)
        throw new Error("2Captcha could not solve challenge")
      return result
    }
    throw new Error("2Captcha unavailable")
  }
  const created = await call("createTask", {
    task: {
      type: "GridTask",
      body: grid.image.toString("base64"),
      comment: grid.instructions,
      rows: grid.rows,
      columns: grid.columns,
      canNoAnswer: 1,
      ...(grid.imageType ? { imgType: grid.imageType } : {}),
    },
  })
  if (!created.taskId) throw new Error("2Captcha response invalid")
  while (Date.now() < until) {
    await waitForBrowserbaseCaptchaIdle(page, until)
    if (await ready()) return null
    const remaining = until - Date.now()
    if (remaining < 5000) throw new Error("2Captcha time budget exceeded")
    await page.waitForTimeout(5000)
    const result = await call("getTaskResult", { taskId: created.taskId })
    if (result.status !== "ready") continue
    if (!result.solution) throw new Error("2Captcha response invalid")
    const clicks =
      result.solution.click === "No_matching_images"
        ? []
        : result.solution.click
    if (
      new Set(clicks).size !== clicks.length ||
      clicks.some((n) => n > grid.tiles.length)
    )
      throw new Error("2Captcha response invalid")
    return clicks
  }
  throw new Error("2Captcha time budget exceeded")
}

export async function tryTwoCaptchaGrid(
  page: Page,
  ready: () => Promise<boolean>,
  until = Infinity
) {
  await waitForBrowserbaseCaptchaIdle(page, until)
  if (await ready()) {
    attempted.delete(page)
    return true
  }
  if (attempted.has(page)) return false
  attempted.add(page)
  const key = process.env.TWOCAPTCHA_API_KEY?.trim()
  const began = Date.now()
  let phase = "configuration"
  let phaseBegan = began
  const setPhase = (next: string) => {
    console.info("Application CAPTCHA timing", {
      phase,
      durationMs: Date.now() - phaseBegan,
      elapsedMs: Date.now() - began,
    })
    phase = next
    phaseBegan = Date.now()
  }
  const report = (outcome: string, reason?: string) =>
    console.info("Application CAPTCHA solver", {
      provider: "2captcha",
      outcome,
      phase,
      elapsedMs: Date.now() - began,
      phaseDurationMs: Date.now() - phaseBegan,
      ...(reason ? { reason } : {}),
    })
  if (!key) {
    report("not_configured")
    return false
  }
  const ends = Math.min(Date.now() + TWO_CAPTCHA_WAIT_MS, until)
  let createAttempts = 0
  let refreshedChallenge = false
  const reserveTask = () => {
    if (createAttempts >= MAX_GRID_TASKS)
      throw new Error("2Captcha task budget exceeded")
    createAttempts++
  }
  if (ends - Date.now() < 15_000) {
    report("insufficient_time")
    return false
  }
  try {
    rounds: for (
      let round = 0;
      round < MAX_GRID_TASKS && Date.now() < ends;
      round++
    ) {
      await waitForBrowserbaseCaptchaIdle(page, ends)
      if (await ready()) {
        attempted.delete(page)
        report("cleared")
        return true
      }
      setPhase("capture_view")
      const view = await readVerificationView(page)
      setPhase("read_grid")
      const grid = await readRecaptchaGrid(view)
      if (!grid) {
        report("unsupported")
        return false
      }
      let clicks: number[] | null
      try {
        clicks = await solveGrid(
          grid,
          key,
          page,
          ready,
          ends,
          setPhase,
          reserveTask
        )
      } catch (error) {
        if (
          !(error instanceof UnsolvableGridError) ||
          refreshedChallenge ||
          createAttempts >= MAX_GRID_TASKS ||
          round + 1 >= MAX_GRID_TASKS ||
          ends - Date.now() < 15_000
        )
          throw error
        setPhase("refresh_challenge")
        refreshedChallenge = true
        if (!(await refreshRecaptchaGrid(page, grid, ready, ends))) throw error
        report("challenge_refreshed")
        continue rounds
      }
      if (clicks === null) {
        attempted.delete(page)
        report("cleared")
        return true
      }
      setPhase("refresh_view")
      let fresh = await readVerificationView(page)
      if (fresh.frame !== view.frame || fresh.url !== view.url) {
        report("stale_view")
        return false
      }
      // The provider answer belongs to the captured picture. A changed picture
      // needs a new task, not stale clicks or an immediate human handoff.
      if (fresh.fingerprint !== view.fingerprint) continue rounds
      for (const tile of clicks.map((n) => grid.tiles[n - 1])) {
        // Dynamic neighbors can finish replacing between our snapshot and the
        // shared click guard. A guard rejection is pre-click, so re-observe a
        // bounded number of times and revalidate this original answer's tile.
        // A replaced target needs a new solution; changed prompts/frames stop.
        for (let attempt = 0; attempt < 3; attempt++) {
          await waitForBrowserbaseCaptchaIdle(page, ends)
          if (await ready()) {
            attempted.delete(page)
            report("cleared")
            return true
          }
          setPhase("validate_tile")
          fresh = await readVerificationView(page)
          const current = await readRecaptchaGrid(fresh, false)
          const target = current?.tiles.find(
            (t) => t.selector === tile.selector
          )
          if (
            !current ||
            current.view.frame !== view.frame ||
            current.view.url !== view.url ||
            current.instructions !== grid.instructions ||
            current.rows !== grid.rows ||
            current.columns !== grid.columns ||
            !target
          ) {
            report("stale_view")
            return false
          }
          // Never carry a click derived from an earlier image into its
          // replacement. Discard the remaining answer and recapture the grid.
          if (target.image !== tile.image) continue rounds
          if (target.selected) break
          const index = fresh.targets.findIndex(
            (t) => t.tile && t.selector === tile.selector
          )
          setPhase("click_tile")
          try {
            await applyVerificationResponse(
              page,
              fresh,
              { action: "click", target: index },
              ends
            )
            break
          } catch (error) {
            if (
              !(error instanceof Error) ||
              error.message !== "Verification view changed" ||
              attempt === 2
            )
              throw error
          }
        }
      }
      if (
        clicks.length &&
        /click verify once there are none left/i.test(grid.instructions)
      ) {
        setPhase("wait_replacements")
        const replacementDeadline = Math.min(ends, Date.now() + 15_000)
        let replaced = false
        while (Date.now() < replacementDeadline) {
          await page.waitForTimeout(
            Math.min(500, replacementDeadline - Date.now())
          )
          await waitForBrowserbaseCaptchaIdle(page, ends)
          if (await ready()) {
            attempted.delete(page)
            report("cleared")
            return true
          }
          const updated = await readRecaptchaGrid(
            await readVerificationView(page, false, false),
            false
          )
          // A new prompt is a new task, never a reason to reuse old clicks.
          if (
            updated &&
            updated.view.frame === view.frame &&
            updated.view.url === view.url &&
            (updated.instructions !== grid.instructions ||
              updated.rows !== grid.rows ||
              updated.columns !== grid.columns)
          )
            continue rounds
          if (
            updated &&
            updated.view.frame === view.frame &&
            updated.view.url === view.url &&
            updated.instructions === grid.instructions &&
            updated.rows === grid.rows &&
            updated.columns === grid.columns &&
            clicks.every(
              (n) => updated.tiles[n - 1]?.image !== grid.tiles[n - 1].image
            )
          ) {
            replaced = true
            break
          }
        }
        if (!replaced) {
          report("unavailable", "replacement_timeout")
          return false
        }
        // Source URLs can change before the fade completes. Let the new grid
        // settle before taking the screenshot that guards the next answer.
        await page.waitForTimeout(Math.min(500, Math.max(0, ends - Date.now())))
        continue rounds
      }
      for (let attempt = 0; attempt < 3; attempt++) {
        setPhase("validate_verify")
        fresh = await readVerificationView(page)
        const current = await readRecaptchaGrid(fresh, false)
        // A rejected guard is pre-click. Re-observe and check the entire solved
        // grid before retrying Verify; replacement images need a new solution.
        if (
          !current ||
          current.view.frame !== view.frame ||
          current.view.url !== view.url ||
          current.instructions !== grid.instructions ||
          current.rows !== grid.rows ||
          current.columns !== grid.columns ||
          current.tiles.some((t, i) => t.image !== grid.tiles[i]?.image)
        )
          continue rounds
        const verifies = fresh.targets
          .map((t, i) => ({ t, i }))
          .filter(({ t }) => !t.tile && /^(?:verify|skip|next)$/i.test(t.label))
        if (verifies.length !== 1) {
          report("unsupported")
          return false
        }
        await waitForBrowserbaseCaptchaIdle(page, ends)
        setPhase("verify_grid")
        try {
          await applyVerificationResponse(
            page,
            fresh,
            { action: "click", target: verifies[0].i },
            ends
          )
          break
        } catch (error) {
          if (
            !(error instanceof Error) ||
            error.message !== "Verification view changed" ||
            attempt === 2
          )
            throw error
        }
      }
      for (let poll = 0; poll < 6 && Date.now() < ends; poll++) {
        if (await ready()) {
          attempted.delete(page)
          report("cleared")
          return true
        }
        await page.waitForTimeout(Math.min(500, Math.max(1, ends - Date.now())))
      }
    }
    report("budget_exhausted")
  } catch (error) {
    // Provider bodies/errors may contain keys or challenge data. No raw error
    // is logged. An active Browserbase solve still blocks any human handoff.
    await waitForBrowserbaseCaptchaIdle(page, until)
    const reasons: Record<string, string> = {
      "2Captcha time budget exceeded": "budget_exhausted",
      "2Captcha task budget exceeded": "budget_exhausted",
      "2Captcha unavailable": "provider_http_error",
      "2Captcha could not solve challenge": "provider_error",
      "2Captcha response invalid": "invalid_solution",
      "Verification view changed": "view_changed",
      "Verification window expired": "budget_exhausted",
      "Invalid verification response": "invalid_control",
    }
    const reason =
      error instanceof z.ZodError
        ? "invalid_provider_response"
        : error instanceof Error
          ? (Object.hasOwn(reasons, error.message)
              ? reasons[error.message]
              : undefined) ||
            (error.name === "TimeoutError"
              ? "operation_timeout"
              : "unexpected_failure")
          : "unexpected_failure"
    report("unavailable", reason)
  }
  return false
}
