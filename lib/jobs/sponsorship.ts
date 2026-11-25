/** Posting evidence only. An employer's register membership is a separate fact. */
export function postingSponsorship(
  description: string,
  country?: string
): {
  signal: "confirmed" | "possible" | "no"
  evidence: string
} {
  const text = description.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ")
  const negative =
    /(?:\bno\s+(?:visa\s+)?sponsorship\b|\b(?:cannot|can't|unable to|do not|don't|will not|won't)\s+(?:provide\s+|offer\s+)?(?:visa\s+)?sponsor(?:ship)?\b|\bsponsorship\s+(?:is\s+)?not\s+(?:available|provided|offered)|\bmust\s+(?:already\s+)?have\s+(?:the\s+)?right\s+to\s+work\b)/i
  const positive =
    /(?:\bwe\s+(?:can\s+|will\s+)?sponsor\s+(?:your\s+)?(?:visa|work permit)|\b(?:offer|provide|available|provides|offers)\s+(?:full\s+)?visa\s+sponsorship|\bvisa\s+sponsorship\s+(?:is\s+)?(?:available|provided|offered|supported))/i
  const no = text.match(negative)
  if (no) return { signal: "no", evidence: snippet(text, no.index ?? 0) }
  const yes = text.match(positive)
  if (yes) {
    const evidence = snippet(text, yes.index ?? 0)
    const scope = evidence.match(
      /\b(?:to|in|for(?: roles in)?)\s+(?:the\s+)?(Germany|Netherlands|Ireland|Denmark|Sweden|Australia|Japan|UAE|United Arab Emirates)\b/i
    )
    if (country && scope && scope[1].toLowerCase() !== country.toLowerCase())
      return {
        signal: /any other country.{0,100}(?:right to work|work auth)/i.test(
          evidence
        )
          ? "no"
          : "possible",
        evidence,
      }
    return { signal: "confirmed", evidence }
  }
  return {
    signal: "possible",
    evidence:
      "No explicit role-level sponsorship commitment found in available text.",
  }
}
function snippet(text: string, index: number) {
  return text.slice(Math.max(0, index - 60), index + 180).trim()
}
