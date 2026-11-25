import { supabaseServerClient } from "@/lib/server/supabase-server"
export async function testReceipt(token: string) {
  if (
    process.env.APP_ENV !== "staging" ||
    !process.env.APPLICATION_TEST_ORIGIN ||
    !/^[-a-f0-9]{36}$/.test(token)
  )
    return null
  const db = supabaseServerClient()
  const r = await db
    .from("application_test_receipts")
    .select("application_id,submissions")
    .eq("token", token)
    .maybeSingle()
  if (r.error) throw r.error
  return r.data
}
export function testHtml(
  body: string,
  status = 200,
  allowFrames = false,
  allowScripts = false
) {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic staging employer</title><style>body{font:16px system-ui;max-width:700px;margin:40px auto;padding:20px}label{display:block;font-weight:600;margin-top:20px}input,textarea,select{font:inherit;padding:10px;max-width:90%}button{margin-top:30px;padding:12px}p{color:#444}</style></head><body>${body}</body></html>`,
    {
      status,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'${allowFrames ? "; frame-src 'self'" : ""}${allowScripts ? "; script-src 'unsafe-inline'" : ""}`,
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      },
    }
  )
}
