// URL syntax is shared with the client. DNS and request-time address checks live
// in the server browser module; accepting a URL here does not authorize a request.
export function publicApplicationUrl(value: string): string | null {
  if (value.length > 8000 || /[\s\\]/.test(value)) return null
  try {
    const url = new URL(value)
    const host = url.hostname
    if (
      url.protocol !== "https:" ||
      url.port ||
      url.username ||
      url.password ||
      !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(host) ||
      /\.(?:localhost|local|internal|home|lan|test|invalid|example)$/.test(host)
    )
      return null
    return url.href
  } catch {
    return null
  }
}
