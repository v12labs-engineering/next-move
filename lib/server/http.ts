import { z } from "zod"

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message)
  }
}

export function privateJson(data: unknown, status = 200) {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  })
}

export function apiError(error: unknown) {
  if (error instanceof HttpError)
    return privateJson({ ok: false, error: error.message }, error.status)
  if (error instanceof z.ZodError || error instanceof SyntaxError) {
    return privateJson(
      { ok: false, error: "Please check the submitted fields." },
      400
    )
  }
  // Messages and details can contain resume text. Log only type and known codes.
  const code =
    error && typeof error === "object" && "code" in error
      ? error.code
      : undefined
  console.error("API request failed", {
    type: error instanceof Error ? error.name : "DatabaseError",
    ...(typeof code === "string" && /^(?:[0-9A-Z]{5}|PGRST\d{3})$/.test(code)
      ? { code }
      : {}),
  })
  return privateJson(
    {
      ok: false,
      error: "The request could not be completed. Please try again.",
    },
    503
  )
}

export function checkOrigin(request: Request) {
  const origin = request.headers.get("origin")
  if (!origin) return

  // A reverse proxy can expose a different origin than Next.js listens on.
  const expectedOrigin =
    process.env.APP_PUBLIC_ORIGIN || new URL(request.url).origin
  if (origin !== expectedOrigin)
    throw new HttpError(403, "Invalid request origin.")
}

export async function readJson(
  request: Request,
  maxBytes = 80_000
): Promise<unknown> {
  checkOrigin(request)
  if (!request.headers.get("content-type")?.includes("application/json"))
    throw new HttpError(415, "Expected JSON.")
  const reader = request.body?.getReader()
  if (!reader) throw new HttpError(400, "Missing request body.")
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maxBytes) {
      await reader.cancel()
      throw new HttpError(413, "Request is too large.")
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  return JSON.parse(new TextDecoder().decode(bytes))
}

export function safeNext(value: string | null) {
  return value && /^\/(?!\/)/.test(value) && !/[\\\u0000-\u0020]/.test(value)
    ? value
    : "/jobs"
}
