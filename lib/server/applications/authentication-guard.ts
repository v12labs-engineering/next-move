import type { Frame, Page, Route } from "playwright-core"

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
