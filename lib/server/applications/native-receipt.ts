import { setTimeout as delay } from "node:timers/promises"
import type { Page } from "playwright-core"
import { visibleCaptchaFrame } from "./captcha-detection"

const normalize = (text: string) =>
  text
    .normalize("NFKC")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
const confirmed =
  /\bthanks? (?:you )?for (?:applying|(?:submitting|sending) (?:your |an )?application|your application)\b|\bapplication (?:has been |was |is )?(?:successfully )?(?:received|submitted|sent)\b|\b(?:we have|we've|we) received your application\b|\bsuccessfully applied\b/i
const rejectedEvidence =
  /\b(?:not|never) (?:been )?(?:received|submitted|sent)|\b(?:unable|failed|failure|error)\b|\b(?:please|must) (?:complete|correct|verify)\b/i
const hypotheticalEvidence =
  /\b(?:once|if|when|after|before|until)\s+(?:your |the |an? )?application\b|\?\s*$/i
const requiredApplicationControls =
  ':is(form,[role="form"]):has(input[type="file"],button:text-matches("^(Submit (my )?application|Send (my )?application|Apply now)$", "i")) :is(input,textarea,select)[required]:visible:enabled:not([type="hidden"])'

// Reject actual submission failures across the surface, but do not let an
// unrelated support/footer mention of "error" invalidate a success heading.
const rejectedSubmission =
  /\b(?:not|never) (?:been )?(?:received|submitted|sent)\b|\b(?:please|must) (?:complete|correct|verify)\b|\b(?:unable|failed) to (?:submit|send|process)\b|\b(?:submission|application) (?:has |was |is )?(?:failed|rejected|blocked|unsuccessful)\b|\berror (?:while |when )?(?:submitting|sending|processing)\b|\b(?:reached|exceeded) (?:the |your )?(?:application|submission) limit\b/i

// Read visible employer evidence, including embedded ATS frames. The model's
// report is a hint; it is never itself a submission receipt.
async function readReceiptOnce(page: Page, quote?: string) {
  for (const candidate of page.context().pages().slice(-5)) {
    const frames = candidate
      .frames()
      .filter((frame) => frame !== candidate.mainFrame())
      .slice(0, 10)
    const surfaces = [candidate, ...frames]
    for (const surface of surfaces) {
      if (surface !== candidate) {
        try {
          if (!(await visibleCaptchaFrame(surface as (typeof frames)[number])))
            continue
        } catch {
          continue
        }
      }
      const body = await surface
        .locator("body")
        .innerText({ timeout: 1000 })
        .catch(() => "")
      if (!body || rejectedSubmission.test(normalize(body))) continue
      // A success-looking sentence in form instructions is not a receipt.
      // Optional newsletter/search controls on a real receipt may remain.
      try {
        if (await surface.locator(requiredApplicationControls).count()) continue
      } catch {
        // Navigation/detachment can interrupt the same read as a delayed receipt.
        // This surface supplied no complete observation; continue polling.
        continue
      }
      if (
        quote &&
        (!confirmed.test(normalize(quote)) ||
          rejectedEvidence.test(normalize(quote)) ||
          !normalize(body).includes(normalize(quote)))
      )
        continue
      const evidence = body
        .split(/\n+|(?<=[.!?])\s+/)
        .map((text) => text.trim())
        .filter(
          (text) =>
            confirmed.test(normalize(text)) &&
            !rejectedEvidence.test(normalize(text)) &&
            !hypotheticalEvidence.test(normalize(text))
        )
        .join(" ")
        .slice(0, 3000)
      if (evidence)
        return {
          text: evidence,
          url: surface.url(),
          confirmedAt: new Date().toISOString(),
        }
    }
  }
  return null
}

// Some ATS pages render their acknowledgement after the click/worker ends.
// Poll only the existing live pages; never navigate or repeat the submission.
export async function readNativeReceipt(
  page: Page,
  quote?: string,
  timeoutMs = 0
) {
  const deadline = Date.now() + Math.max(0, timeoutMs)
  do {
    const receipt = await readReceiptOnce(page, quote)
    if (receipt) return receipt
    const remaining = deadline - Date.now()
    if (remaining <= 0) return null
    await delay(Math.min(250, remaining))
  } while (Date.now() <= deadline)
  return null
}
