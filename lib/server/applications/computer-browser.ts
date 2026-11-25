import { createHash } from "node:crypto"
import type { Frame, Page, Route } from "playwright-core"
import { performBrowserAction } from "./browser-actions"
import {
  browserbaseCaptchaReady,
  waitForBrowserbaseCaptchaIdle,
} from "./captcha"
import { tryTwoCaptchaGrid } from "./two-captcha"

// Human field assistance may read/search, but must not send an application or
// navigate away. The existing public-network guard remains in the route chain.
export async function withFieldAssistance<T>(
  page: Page,
  run: () => Promise<T>
) {
  const context = page.context()
  const guard = async (route: Route) => {
    const request = route.request()
    if (
      request.isNavigationRequest() ||
      !["GET", "HEAD", "OPTIONS"].includes(request.method())
    )
      await route.abort("blockedbyclient")
    else await route.fallback()
  }
  await context.route("**/*", guard)
  try {
    return await run()
  } finally {
    await context.unroute("**/*", guard)
  }
}

// Early sign-in can write authentication data, but cannot send the application.
// Only observed password/code form destinations/fields and existing challenge
// frames receive write permission. Unknown authentication transports stay paused.
export async function withAuthenticationAssistance<T>(
  page: Page,
  run: () => Promise<T>
) {
  const forms: {
    action: string
    names: string[]
    credentials: string[]
    method: string
  }[] = []
  const challenges = new Map<Frame, string>()
  for (const frame of page.frames()) {
    try {
      forms.push(
        ...(await frame.evaluate(() =>
          Array.from(document.forms)
            .filter((form) =>
              form.querySelector(
                'input[type="password"],input[autocomplete="one-time-code"]'
              )
            )
            .map((form) => ({
              action: form.action || location.href,
              names: Array.from(form.elements)
                .map((el) => (el as HTMLInputElement).name)
                .filter(Boolean),
              credentials: Array.from(
                form.querySelectorAll<HTMLInputElement>(
                  'input[type="password"],input[autocomplete="one-time-code"]'
                )
              )
                .map((el) => el.name)
                .filter(Boolean),
              method: form.method.toUpperCase(),
            }))
        ))
      )
      if (/captcha|challenge|bframe/i.test(frame.url()))
        challenges.set(frame, new URL(frame.url()).origin)
    } catch {
      /* Inaccessible frames grant no write capability. */
    }
  }
  const destination = (url: string) => {
    const parsed = new URL(url)
    parsed.hash = ""
    return parsed.href
  }
  const context = page.context()
  const authorizedRedirects = new WeakSet<object>()
  const guard = async (route: Route) => {
    try {
      const request = route.request()
      const auth = forms.filter(
        (form) => destination(form.action) === destination(request.url())
      )
      const previous = request.redirectedFrom()
      const redirect = !!previous && authorizedRedirects.has(previous)
      const challenge =
        challenges.get(request.frame()) === new URL(request.url()).origin
      if (["GET", "HEAD", "OPTIONS"].includes(request.method())) {
        // A new application form may appear after login. Unknown navigations
        // and data requests are never authorized by the earlier login page.
        const data = ["xhr", "fetch"].includes(request.resourceType())
        if ((request.isNavigationRequest() || data) && !redirect && !challenge)
          await route.abort("blockedbyclient")
        else {
          if (redirect) authorizedRedirects.add(request)
          await route.fallback()
        }
        return
      }
      let names: string[] = []
      try {
        const data = request.postDataJSON()
        if (data && typeof data === "object" && !Array.isArray(data))
          names = Object.keys(data)
      } catch {
        /* Unknown bodies cannot authorize a write. */
      }
      const verifiedForm = auth.some(
        (form) =>
          form.method === request.method() &&
          form.credentials.length > 0 &&
          form.credentials.every((name) => names.includes(name)) &&
          names.every((name) => form.names.includes(name))
      )
      if (verifiedForm || challenge) {
        authorizedRedirects.add(request)
        await route.fallback()
      } else await route.abort("blockedbyclient")
    } catch {
      await route.abort("blockedbyclient")
    }
  }
  await context.route("**/*", guard)
  try {
    return await run()
  } finally {
    await context.unroute("**/*", guard)
  }
}

// Generic browser observations: no ATS names, classes, endpoints or adapters.
export function readComputerDocument() {
  const shadowText: string[] = []
  const noticeText: string[] = []
  const controls: {
    selector: string
    tag: string
    type: string
    role: string
    label: string
    group: string
    context: string
    id: string
    name: string
    required: boolean
    disabled: boolean
    options: string[]
    value: string
    checked: boolean
    valid: boolean
    selectedText: string
    dropdown?: {
      searchText: string
      selectedLabels: string[] | null
      expanded: boolean
    }
    selectionObservable: boolean
    href: string
    scope: string
    autocomplete: string
    inViewport: boolean
  }[] = []
  // Object methods retain their names without injected server-only helpers.
  // This function is serialized into a fresh employer browser by Playwright.
  const {
    visible,
    path,
    scan,
    markedRequired,
    yesNoBackingInput,
    dropdownState,
  } = {
    visible(el: Element) {
      return (
        !!el.getClientRects().length &&
        getComputedStyle(el).visibility !== "hidden" &&
        getComputedStyle(el).display !== "none"
      )
    },
    dropdownState(node: HTMLElement, valueNodes: Set<Element>) {
      let selectedLabels: string[] | null = null
      if (node.hasAttribute("aria-valuetext"))
        selectedLabels = [node.getAttribute("aria-valuetext") || ""].filter(
          Boolean
        )
      // React Select exposes its committed value beside the search input.
      // Recognize the widget's value slots, never arbitrary nearby prose.
      let parent = node.parentElement
      for (
        let depth = 0;
        parent && depth < 4;
        depth++, parent = parent.parentElement
      ) {
        if (
          parent.tagName === "FORM" ||
          parent.querySelectorAll(
            'input:not([type="hidden"]),textarea,select,[role="combobox"]'
          ).length !== 1
        )
          break
        const values = Array.from(
          parent.querySelectorAll<HTMLElement>(
            '[class*="__single-value"],[class*="__multi-value__label"],[class$="-singleValue"],[class$="-multiValue"]'
          )
        ).filter(visible)
        if (values.length) {
          selectedLabels = values
            .map((el) => el.innerText.trim())
            .filter(Boolean)
          values.forEach((el) => valueNodes.add(el))
          break
        }
      }
      if (!selectedLabels && !["INPUT", "TEXTAREA"].includes(node.tagName))
        selectedLabels = [node.innerText.trim()].filter(Boolean)
      return {
        searchText: ["INPUT", "TEXTAREA"].includes(node.tagName)
          ? (node as HTMLInputElement).value
          : "",
        selectedLabels,
        expanded: node.getAttribute("aria-expanded") === "true",
      }
    },
    yesNoBackingInput(node: HTMLElement): HTMLInputElement | null {
      // Some widgets use two pressed buttons and one non-focusable checkbox
      // solely for form state. Keep the real choices and their observed name.
      const parent = node.parentElement
      if (!parent || parent.children.length !== 3) return null
      const input = parent.querySelector<HTMLInputElement>(
        ':scope > input[type="checkbox"][tabindex="-1"]'
      )
      const buttons = Array.from(
        parent.querySelectorAll<HTMLButtonElement>(":scope > button")
      )
      if (!input || input.labels?.length || !input.name || buttons.length !== 2)
        return null
      if (node !== input && !buttons.includes(node as HTMLButtonElement))
        return null
      const labels = buttons
        .map((button) => button.innerText.trim().toLowerCase())
        .sort()
      return labels.join(",") === "no,yes" &&
        buttons.every((button) => button.hasAttribute("aria-pressed"))
        ? input
        : null
    },
    path(el: Element): string {
      // Value chips may insert siblings around a search input. A unique DOM ID
      // survives that change; full question identity is still checked on use.
      if (el.id && el.getAttribute("role") === "combobox") {
        const root = el.getRootNode() as Document | ShadowRoot
        const selector = `#${CSS.escape(el.id)}`
        if (root.querySelectorAll(selector).length === 1)
          return root instanceof ShadowRoot
            ? `${path(root.host)} >> ${selector}`
            : selector
      }
      const parts: string[] = []
      let current: Element | null = el
      while (current) {
        const siblings = Array.from(
          current.parentElement?.children || []
        ).filter((e) => e.tagName === current!.tagName)
        parts.unshift(
          `${current.tagName.toLowerCase()}:nth-of-type(${Math.max(0, siblings.indexOf(current)) + 1})`
        )
        if (
          !current.parentElement &&
          current.getRootNode() instanceof ShadowRoot
        ) {
          return (
            path((current.getRootNode() as ShadowRoot).host) +
            " >> " +
            parts.join(" > ")
          )
        }
        current = current.parentElement
      }
      return parts.join(" > ")
    },
    scan(root: Document | ShadowRoot) {
      const valueNodes = new Set<Element>()
      const dropdowns = new Map(
        Array.from(root.querySelectorAll<HTMLElement>('[role="combobox"]')).map(
          (node) => [node, dropdownState(node, valueNodes)] as const
        )
      )
      const walker = document.createTreeWalker(
        root instanceof Document
          ? root.body || root.documentElement || root
          : root,
        NodeFilter.SHOW_TEXT
      )
      for (let text = walker.nextNode(); text; text = walker.nextNode()) {
        const parent = text.parentElement
        if (
          parent &&
          visible(parent) &&
          !Array.from(valueNodes).some((el) => el.contains(parent)) &&
          !parent.closest(
            'script,style,input,textarea,select,button,[role="combobox"],[role="option"],[role="listbox"],[role="status"],[contenteditable="true"]'
          )
        )
          noticeText.push(text.textContent || "")
      }
      if (root instanceof ShadowRoot)
        shadowText.push(
          Array.from(root.children)
            .filter((el) => visible(el) && !el.matches("script,style"))
            .map((el) => (el as HTMLElement).innerText || "")
            .join("\n")
        )
      for (const node of root.querySelectorAll<HTMLElement>("*")) {
        if (node.shadowRoot) scan(node.shadowRoot)
        // Options belong to one question, not to the page's control budget.
        if (node.closest('[role="option"]')) continue
        if (
          !node.matches(
            'input:not([type="hidden"]),textarea,select,button,a[href],[role="button"],[role="textbox"],[role="checkbox"],[role="radio"],[role="combobox"],[role="option"],[contenteditable="true"]'
          )
        )
          continue
        const input = node as HTMLInputElement
        const backingInput = yesNoBackingInput(node)
        if (backingInput === node) continue
        const file = node.tagName === "INPUT" && input.type === "file"
        if (!visible(node) && !file) continue
        if (
          !visible(node) &&
          file &&
          !Array.from(input.labels || []).some(visible) &&
          (!node.parentElement || !visible(node.parentElement))
        )
          continue
        const labels = [
          ...new Set(
            Array.from(input.labels || []).map((l) => l.innerText.trim())
          ),
        ]
          .filter(Boolean)
          .join(" ")
        const referenced = (node.getAttribute("aria-labelledby") || "")
          .split(/\s+/)
          .map(
            (id) =>
              (node.getRootNode() as Document | ShadowRoot).getElementById(id)
                ?.textContent || ""
          )
          .join(" ")
          .trim()
        const group = node.closest(
          'fieldset,[role="group"],[role="radiogroup"]'
        )
        let groupHeading =
          group?.querySelector(
            ':scope > legend,:scope > label,:scope > p,:scope > [role="heading"]'
          ) || null
        if (!groupHeading) {
          let ancestor = node.parentElement
          for (
            let depth = 0;
            ancestor && depth < 4;
            depth++, ancestor = ancestor.parentElement
          ) {
            const labels = ancestor.querySelectorAll(
              ":scope > label,:scope > legend"
            )
            if (labels.length === 1) {
              groupHeading = labels[0]
              break
            }
          }
        }
        let groupLabel =
          groupHeading?.textContent?.trim() ||
          group?.getAttribute("aria-label") ||
          ""
        // A date picker can have an unassociated question label several
        // wrappers above its input. Placeholder text describes the widget,
        // not the question. Only borrow a heading belonging to this one input;
        // a shared heading such as Contact details must not rename siblings.
        const singleQuestionLabel =
          groupHeading?.parentElement?.querySelectorAll(
            'input:not([type="hidden"]),textarea,select,[role="combobox"]'
          ).length === 1
            ? groupLabel
            : ""
        if (["radio", "checkbox"].includes(input.type) && input.name) {
          const members = Array.from(
            root.querySelectorAll<HTMLInputElement>(
              'input[type="radio"],input[type="checkbox"]'
            )
          ).filter(
            (other) => other.type === input.type && other.name === input.name
          )
          let ancestor = node.parentElement
          for (
            let depth = 0;
            ancestor && depth < 6;
            depth++, ancestor = ancestor.parentElement
          ) {
            if (!members.every((member) => ancestor!.contains(member))) continue
            const questions = Array.from(
              ancestor.querySelectorAll<HTMLInputElement>(
                'input:not([type="hidden"]),textarea,select'
              )
            )
            if (
              questions.some(
                (question) =>
                  question.type !== input.type || question.name !== input.name
              )
            )
              break
            const copy = ancestor.cloneNode(true) as HTMLElement
            copy.querySelectorAll("label").forEach((label) => {
              if (
                label.querySelector("input") ||
                members.some(
                  (member) => member.id && member.id === label.htmlFor
                )
              )
                label.remove()
            })
            copy
              .querySelectorAll("input,button,script,style")
              .forEach((element) => element.remove())
            const heading = (copy.textContent || "").replace(/\s+/g, " ").trim()
            if (heading) {
              groupLabel = heading.slice(0, 2000)
              break
            }
          }
        }
        const rect = node.getBoundingClientRect()
        const form = input.form || node.closest('form,[role="form"]')
        controls.push({
          selector: path(node),
          tag: node.tagName.toLowerCase(),
          type: node.isContentEditable
            ? "contenteditable"
            : node.tagName === "BUTTON" && !(node as HTMLButtonElement).form
              ? "button"
              : input.type || "",
          role: node.getAttribute("role") || "",
          label: (
            node.getAttribute("aria-label") ||
            referenced ||
            labels ||
            (!node.matches('button,a,[role="button"],[role="option"]')
              ? singleQuestionLabel
              : "") ||
            node.getAttribute("placeholder") ||
            (node.matches('button,a,[role="button"],[role="option"]')
              ? node.innerText
              : "") ||
            ""
          )
            .trim()
            .slice(0, 2000),
          group: groupLabel.slice(0, 2000),
          context: (node.parentElement?.parentElement?.innerText || "").slice(
            0,
            800
          ),
          id: node.id,
          name: backingInput?.name || input.name || "",
          required:
            !!input.required ||
            !!backingInput?.required ||
            node.getAttribute("aria-required") === "true" ||
            [
              ...Array.from(input.labels || []),
              ...(groupHeading ? [groupHeading] : []),
            ].some(markedRequired),
          disabled:
            !!input.disabled || node.getAttribute("aria-disabled") === "true",
          options:
            node.tagName === "SELECT"
              ? Array.from((node as unknown as HTMLSelectElement).options)
                  .filter((o) => o.value)
                  .map((o) => o.text.trim())
              : node.getAttribute("role") === "combobox"
                ? [
                    ...new Set(
                      `${node.getAttribute("aria-controls") || ""} ${node.getAttribute("aria-owns") || ""}`
                        .trim()
                        .split(/\s+/)
                        .filter(Boolean)
                    ),
                  ]
                    .flatMap((id) =>
                      Array.from(
                        (node.getRootNode() as Document | ShadowRoot)
                          .getElementById(id)
                          ?.querySelectorAll<HTMLElement>('[role="option"]') ||
                          []
                      )
                    )
                    .map((option) => option.textContent?.trim() || "")
                    .filter(Boolean)
                : [],
          value: file
            ? input.files?.length
              ? "[file selected]"
              : ""
            : (node.isContentEditable ||
              (node.getAttribute("role") === "combobox" &&
                !["INPUT", "TEXTAREA", "SELECT"].includes(node.tagName))
                ? node.getAttribute("aria-valuetext") || node.innerText
                : input.value || ""
              ).slice(0, 5000),
          checked:
            !!input.checked ||
            node.getAttribute("aria-checked") === "true" ||
            node.getAttribute("aria-pressed") === "true",
          valid:
            (input.validity?.valid ?? true) &&
            !["true", "grammar", "spelling"].includes(
              node.getAttribute("aria-invalid") || ""
            ),
          selectedText:
            node.tagName === "SELECT"
              ? (
                  node as unknown as HTMLSelectElement
                ).selectedOptions[0]?.text.trim() || ""
              : "",
          ...(dropdowns.has(node) ? { dropdown: dropdowns.get(node)! } : {}),
          selectionObservable:
            node.hasAttribute("aria-checked") ||
            node.hasAttribute("aria-pressed"),
          href: node instanceof HTMLAnchorElement ? node.href : "",
          scope: form ? path(form) : "body",
          autocomplete: input.autocomplete || "",
          inViewport:
            rect.bottom > 0 &&
            rect.top < innerHeight &&
            rect.right > 0 &&
            rect.left < innerWidth,
        })
        if (controls.length > 240)
          throw new Error("Application form exceeds browser observation limit")
      }
    },
    markedRequired(label: Element) {
      return (
        /[*]/.test(label.textContent || "") ||
        /\(required\)/i.test(label.textContent || "") ||
        label.getAttribute("data-required") === "true" ||
        ["::before", "::after"].some((pseudo) =>
          getComputedStyle(label, pseudo).content.includes("*")
        )
      )
    },
  }
  scan(document)
  return {
    title: document.title.slice(0, 500),
    text: [document.body?.innerText || "", ...shadowText]
      .join("\n")
      .slice(0, 24000),
    notices: noticeText.join(" ").replace(/\s+/g, " ").trim().slice(0, 15000),
    controls,
  }
}
export type ComputerControl = ReturnType<
  typeof readComputerDocument
>["controls"][number] & { target: string; frame: number }
export type ComputerObservation = {
  epoch: number
  title: string
  text: string
  notices: string
  controls: ComputerControl[]
  image: Buffer
}

export function controlIdentity(control: ComputerControl) {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(control).filter(
        ([key]) =>
          ![
            "value",
            "checked",
            "valid",
            "selectedText",
            "inViewport",
            "target",
            "context",
            "dropdown",
          ].includes(key)
      )
    )
  )
}
export function questionControl(control: ComputerControl) {
  return (
    !control.disabled &&
    ((["input", "textarea", "select"].includes(control.tag) &&
      !["submit", "button", "reset"].includes(control.type)) ||
      ["textbox", "checkbox", "radio", "combobox"].includes(control.role) ||
      (control.tag === "button" &&
        control.type !== "submit" &&
        !!control.group &&
        /^(yes|no)$/i.test(control.label)) ||
      (control.tag !== "button" && control.type === "contenteditable"))
  )
}
export function computerFieldId(
  controls: ComputerControl[],
  label: string,
  step: number
) {
  const names = new Set(controls.map((c) => c.name).filter(Boolean))
  const base =
    controls.length > 1 && names.size === 1
      ? [...names][0]
      : controls[0].id ||
        controls[0].name ||
        createHash("sha256")
          .update(label + controls.map((c) => c.type || c.role).join())
          .digest("hex")
          .slice(0, 20)
  return `${step ? `${step}:` : ""}${controls[0].frame ? `frame${controls[0].frame}:` : ""}${base}`
}

export class ComputerBrowser {
  private epoch = 0
  private frames: Frame[] = []
  observation!: ComputerObservation
  constructor(readonly page: Page) {}
  private async visibleFrames() {
    const visible: Frame[] = []
    for (const frame of this.page.frames()) {
      if (frame.isDetached()) throw new Error("Application frame changed")
      let shown = true
      // A nested frame is hidden when any embedding ancestor is hidden.
      for (
        let current = frame;
        current.parentFrame();
        current = current.parentFrame()!
      ) {
        const element = await current.frameElement()
        try {
          if (!(await element.isVisible())) {
            shown = false
            break
          }
        } finally {
          await element.dispose()
        }
      }
      if (!shown) continue
      visible.push(frame)
      if (visible.length > 12)
        throw new Error("Unsupported employer form: too many visible frames")
    }
    return visible
  }
  async waitForCaptcha(wait = true) {
    // Challenge frames can lack an accessible execution context. Detect them
    // before evaluating frame DOMs so human handoff cannot hang on that context.
    const ready = async () =>
      !(await this.page
        .locator(
          'iframe[src*="bframe"]:visible,iframe[src*="challenge"]:visible'
        )
        .count())
    if (!wait) {
      if (!(await browserbaseCaptchaReady(this.page, ready)))
        throw new Error("Human verification required")
      return
    }
    if (
      await tryTwoCaptchaGrid(this.page, () =>
        browserbaseCaptchaReady(this.page, ready)
      )
    )
      return
    throw new Error("Human verification required")
  }
  async observe({
    screenshot = true,
    maskInputs = false,
    waitForCaptcha = true,
  }: {
    screenshot?: boolean
    maskInputs?: boolean
    waitForCaptcha?: boolean
  } = {}) {
    await this.waitForCaptcha(waitForCaptcha)
    this.frames = await this.visibleFrames()
    const controls: ComputerControl[] = []
    const text: string[] = []
    const notices: string[] = []
    let title = ""
    for (const [index, frame] of this.frames.entries()) {
      const doc = await frame.evaluate(readComputerDocument)
      if (!index) title = doc.title
      text.push(doc.text)
      notices.push(doc.notices)
      for (const control of doc.controls)
        controls.push({
          ...control,
          frame: index,
          target: `c${controls.length}`,
        })
    }
    if (controls.some((c) => c.type === "password"))
      throw new Error("Human verification required")
    // Polling still checks complete DOM/frame/challenge state. Only observations
    // actually consumed by a model need a fresh image transfer as well.
    const image = screenshot
      ? await this.page.screenshot({
          type: "jpeg",
          quality: 65,
          timeout: 12000,
          ...(maskInputs
            ? {
                mask: this.frames.map((frame) =>
                  frame.locator("input,textarea")
                ),
              }
            : {}),
        })
      : Buffer.alloc(0)
    this.observation = {
      epoch: ++this.epoch,
      title,
      text: text.join("\n").slice(0, 30000),
      notices: notices.join("\n").slice(0, 15000),
      controls,
      image,
    }
    return this.observation
  }
  control(epoch: number, target: string) {
    if (epoch !== this.observation.epoch)
      throw new Error("Stale computer observation; observe again")
    const control = this.observation.controls.find((c) => c.target === target)
    if (!control || control.disabled)
      throw new Error("Unobserved browser control")
    return control
  }
  async currentControl(control: ComputerControl, changingOptions = false) {
    await this.waitForCaptcha()
    const frame = this.frames[control.frame]
    if (!frame || frame.isDetached())
      throw new Error("Application frame changed")
    const current = (await frame.evaluate(readComputerDocument)).controls.find(
      (c) => c.selector === control.selector
    )
    if (
      !current ||
      controlIdentity({
        ...current,
        ...(changingOptions ? { options: control.options } : {}),
        target: control.target,
        frame: control.frame,
      }) !== controlIdentity(control)
    )
      throw new Error("Application control changed; observe again")
    return { ...current, frame: control.frame, target: control.target }
  }
  async locator(control: ComputerControl, changingOptions = false) {
    await this.currentControl(control, changingOptions)
    const frame = this.frames[control.frame]
    const locator = frame.locator(control.selector)
    if ((await locator.count()) !== 1)
      throw new Error("Ambiguous browser control")
    return locator
  }
  async action(control: ComputerControl, method: "click" | "fill", value = "") {
    const locator = await this.locator(control, control.role === "combobox")
    // Perception already bound the exact target, and locator revalidated it.
    // Native fill emits normal input/change events and has no model routing,
    // temporary DOM markers, or second CDP connection for each text value.
    if (method === "fill") await locator.fill(value, { timeout: 12000 })
    else
      await performBrowserAction(
        this.page,
        this.frames[control.frame],
        locator,
        method,
        value
      )
    await waitForBrowserbaseCaptchaIdle(this.page)
  }
  async fileHash(control: ComputerControl) {
    const locator = await this.locator(control)
    const bytes = await locator.evaluate(async (node) => {
      const file = (node as HTMLInputElement).files?.[0]
      if (
        (node as HTMLInputElement).files?.length !== 1 ||
        !file ||
        file.size > 2_000_000
      )
        return null
      return Array.from(new Uint8Array(await file.arrayBuffer()))
    })
    return bytes
      ? createHash("sha256").update(Buffer.from(bytes)).digest("hex")
      : null
  }
  // File inputs report a selection immediately; the employer's widget may still
  // be uploading or reject the file. Read only the control's own observed area.
  async awaitUpload(control: ComputerControl) {
    const deadline = Date.now() + 20000
    while (true) {
      const frame = this.frames[control.frame]
      if (!frame || frame.isDetached())
        throw new Error("Application frame changed")
      const current = (
        await frame.evaluate(readComputerDocument)
      ).controls.find((c) => c.selector === control.selector)
      const area = current?.context || ""
      if (
        /(?:upload|file)[^\n]{0,40}(?:failed|error|too large|not supported|not allowed|invalid)|(?:failed|unable) to upload|file (?:type|format|size)[^\n]{0,20}not (?:allowed|supported)/i.test(
          area
        )
      )
        throw new Error("Employer rejected the uploaded document")
      if (!/\buploading\b|\b\d{1,2}\s?%|\b(?:processing|parsing)\b/i.test(area))
        return
      if (Date.now() >= deadline)
        throw new Error("Employer document upload did not finish")
      await this.page.waitForTimeout(500)
    }
  }
  // Search-backed dropdowns render options only while open. Opening one and
  // closing it with Escape reads the choices without selecting anything.
  async dropdownOptions(control: ComputerControl): Promise<string[]> {
    const locator = await this.locator(control)
    try {
      // Keyboard opening avoids host-page overlays that intercept clicks.
      await locator.focus({ timeout: 5000 })
      await locator.press("ArrowDown")
      // Read only this dropdown's own listbox: pages keep other option lists
      // (phone country pickers) rendered but hidden.
      const read = () =>
        locator.evaluate((node) => {
          const id =
            node.getAttribute("aria-controls") || node.getAttribute("aria-owns")
          const list = id
            ? (node.getRootNode() as Document | ShadowRoot).getElementById(id)
            : null
          return Array.from(
            list?.querySelectorAll<HTMLElement>('[role="option"]') ?? []
          ).map((option) => option.textContent?.trim() || "")
        })
      let texts: string[] = []
      for (let attempt = 0; attempt < 6 && !texts.length; attempt++) {
        if (attempt) await new Promise((resolve) => setTimeout(resolve, 250))
        texts = await read()
      }
      return [...new Set(texts.filter(Boolean))]
        .filter((text) => text.length <= 1000)
        .slice(0, 500)
    } catch {
      return []
    } finally {
      await locator.press("Escape").catch(() => {})
    }
  }
  async optionLocator(control: ComputerControl, label: string) {
    const locator = await this.locator(control, true)
    const selectors = await locator.evaluate((node) => {
      const root = node.getRootNode() as Document | ShadowRoot
      const ids = [
        ...new Set(
          `${node.getAttribute("aria-controls") || ""} ${node.getAttribute("aria-owns") || ""}`
            .trim()
            .split(/\s+/)
            .filter(Boolean)
        ),
      ]
      return ids
        .filter(
          (id) => root.getElementById(id)?.getAttribute("role") === "listbox"
        )
        .map((id) => `#${CSS.escape(id)}`)
    })
    // No frame-wide fallback: repeated Yes/No choices can belong to other fields.
    const rootPath = control.selector.split(" >> ").slice(0, -1)
    const scoped = selectors.length
      ? [...rootPath, selectors.join(",")].join(" >> ")
      : ":not(*)"
    return this.frames[control.frame].locator(scoped).getByRole("option", {
      name: label,
      exact: true,
    })
  }
  async waitForDropdownOption(control: ComputerControl, label: string) {
    const deadline = Date.now() + 12000
    do {
      const option = await this.optionLocator(control, label)
      if ((await option.count()) > 1)
        throw new Error("Ambiguous employer option")
      if ((await option.count()) === 1 && (await option.isVisible()))
        return option
      await this.page.waitForTimeout(100)
    } while (Date.now() < deadline)
    throw new Error("Approved employer option is unavailable")
  }
  async assertUnchanged() {
    await this.waitForCaptcha()
    const current: ComputerControl[] = []
    const notices: string[] = []
    const frames = await this.visibleFrames()
    if (
      frames.length !== this.frames.length ||
      frames.some((frame, index) => frame !== this.frames[index])
    )
      throw new Error("Employer form changed; observe and review again")
    for (const [index, frame] of this.frames.entries()) {
      const doc = await frame.evaluate(readComputerDocument)
      notices.push(doc.notices)
      current.push(
        ...doc.controls.map((c) => ({ ...c, frame: index, target: "" }))
      )
    }
    if (
      notices.join("\n").slice(0, 15000) !== this.observation.notices ||
      JSON.stringify(current.map(controlIdentity)) !==
        JSON.stringify(this.observation.controls.map(controlIdentity))
    )
      throw new Error("Employer form changed; observe and review again")
    return current
  }
}
