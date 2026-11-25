import assert from "node:assert/strict"
import { chromium } from "playwright-core"
import { readVerificationView } from "../../lib/server/applications/verification-surface"
import { readRecaptchaGrid } from "../../lib/server/applications/two-captcha"
const browser = await chromium.launch({ channel: "chrome", headless: true })
try {
  const context = await browser.newContext()
  const page = await context.newPage()
  await context.route("**/*", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<iframe src="https://www.google.com/recaptcha/enterprise/bframe" width="600" height="600"></iframe>',
    })
  )
  await context.route(
    "https://www.google.com/recaptcha/enterprise/bframe",
    (route) =>
      route.fulfill({ contentType: "text/html", body: "<body></body>" })
  )
  await page.goto("https://captcha-fixture.test")
  const frame = page.frames().find((f) => f.url().includes("/bframe"))!
  await frame.locator("body").waitFor()
  let checks = 0
  for (const size of [3, 4]) {
    const base = `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${size * 100}" height="${size * 100}"><rect width="100%" height="100%" fill="blue"/></svg>`)}`
    const tile = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100%" height="100%" fill="red"/></svg>')}`
    const html = `<style>td{padding:0}td div{width:100px;height:100px;overflow:hidden;position:relative}img{position:absolute}.rc-imageselect-tileselected{outline:8px solid green}</style><div class="rc-imageselect-desc-wrapper">Select all squares with bicycles</div><table>${Array.from({ length: size }, (_, row) => `<tr>${Array.from({ length: size }, (_, col) => `<td ${row === 0 && col === 0 ? 'class="rc-imageselect-tileselected"' : ""}><div><img class="rc-image-tile-${size}${size}" src="${base}" style="left:-${col * 100}px;top:-${row * 100}px"></div></td>`).join("")}</tr>`).join("")}</table><button>Verify</button>`
    await frame.setContent(html)
    if (size === 3)
      await frame
        .locator("td")
        .nth(4)
        .locator("img")
        .evaluate((img, src) => {
          img.setAttribute("src", src)
          img.setAttribute("class", "rc-image-tile-11")
          img.setAttribute("style", "left:0;top:0")
        }, tile)
    await frame
      .locator("img")
      .evaluateAll(
        async (imgs) =>
          await Promise.all(
            imgs.map((img) => (img as HTMLImageElement).decode())
          )
      )
    const grid = await readRecaptchaGrid(await readVerificationView(page))
    assert.ok(grid)
    assert.equal(grid.imageType, "recaptcha")
    const decoded = await frame.evaluate(async (b64) => {
      const img = new Image()
      img.src = "data:image/jpeg;base64," + b64
      await img.decode()
      const canvas = document.createElement("canvas")
      canvas.width = img.naturalWidth
      canvas.height = img.naturalHeight
      const ctx = canvas.getContext("2d")!
      ctx.drawImage(img, 0, 0)
      return {
        width: canvas.width,
        height: canvas.height,
        corner: [...ctx.getImageData(2, 2, 1, 1).data],
        center: [...ctx.getImageData(150, 150, 1, 1).data],
      }
    }, grid.image.toString("base64"))
    assert.equal(decoded.width, size * 100)
    assert.equal(decoded.height, size * 100)
    assert.ok(
      decoded.corner[2] > 240 && decoded.corner[1] < 10,
      "selection outlines must not enter original image"
    )
    if (size === 3)
      assert.ok(
        decoded.center[0] > 240 && decoded.center[2] < 10,
        "updated center tile must replace old sprite pixels"
      )
    checks++
  }
  console.log(
    JSON.stringify({
      passed: true,
      checks,
      sourceImages: true,
      employerSubmissions: 0,
    })
  )
} finally {
  await browser.close()
}
