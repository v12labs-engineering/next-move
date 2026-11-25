import { requireAccount } from "@/lib/server/session"
import { extractResume } from "@/lib/server/resume/import"
import {
  apiError,
  checkOrigin,
  HttpError,
  privateJson,
} from "@/lib/server/http"
export const runtime = "nodejs"
export const maxDuration = 30
export async function POST(request: Request) {
  try {
    await requireAccount()
    checkOrigin(request)
    const name = decodeURIComponent(request.headers.get("x-file-name") ?? "")
    const reader = request.body?.getReader()
    if (!reader) throw new HttpError(400, "Choose a resume file.")
    const chunks: Uint8Array[] = []
    let size = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 2_000_000) {
        await reader.cancel()
        throw new HttpError(413, "Choose a file smaller than 2 MB.")
      }
      chunks.push(value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.length
    }
    let text: string
    try {
      text = await extractResume(bytes, name)
    } catch (error) {
      if (error instanceof HttpError) throw error
      throw new HttpError(
        400,
        "Could not read this resume. Please paste its text instead."
      )
    }
    return privateJson({ ok: true, text })
  } catch (error) {
    return apiError(error)
  }
}
