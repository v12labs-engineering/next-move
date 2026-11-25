import Browserbase, { toFile } from "@browserbasehq/sdk"
import type { BrowserContext } from "playwright-core"

type Document = { buffer: Buffer; name: string; mimeType: string }
type Upload = (file: Document) => Promise<string>
const uploads = new WeakMap<BrowserContext, Upload>()
export function bindDocumentUpload(context: BrowserContext, upload: Upload) {
  uploads.set(context, upload)
  return () => {
    uploads.delete(context)
  }
}
export async function uploadApplicationDocuments(
  context: BrowserContext,
  sessionId: string,
  documents: Document[]
) {
  const upload = uploads.get(context)
  if (upload) return Promise.all(documents.map(upload))
  const bb = new Browserbase({
    apiKey: process.env.BROWSERBASE_API_KEY,
    fetch: (input, init) =>
      globalThis.fetch(input, { ...init, duplex: "half" } as RequestInit),
    maxRetries: 0,
    timeout: 20_000,
  })
  for (const file of documents)
    await bb.sessions.uploads.create(sessionId, {
      file: await toFile(file.buffer, file.name, { type: file.mimeType }),
    })
  return documents.map((file) => `/tmp/.uploads/${file.name}`)
}
