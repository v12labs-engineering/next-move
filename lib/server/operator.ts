import { timingSafeEqual } from "node:crypto"
import { HttpError } from "@/lib/server/http"
export function requireOperator(request: Request) {
  const secret = process.env.INGESTION_SECRET
  const header = request.headers.get("authorization") ?? ""
  if (!secret || secret.length < 32)
    throw new HttpError(503, "Ingestion is not configured.")
  const supplied = Buffer.from(header)
  const expected = Buffer.from(`Bearer ${secret}`)
  if (
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  )
    throw new HttpError(401, "Unauthorized.")
}
