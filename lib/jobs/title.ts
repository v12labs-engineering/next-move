const ENTITY_REPLACEMENTS: Record<string, string> = {
  amp: "&",
  apos: "'",
  lt: "<",
  gt: ">",
  nbsp: " ",
  quot: '"',
}

export function sanitizeJobTitle(title: string): string {
  return title
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, " ")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&([a-z]+);/gi, (_, entity: string) => {
      return ENTITY_REPLACEMENTS[entity.toLowerCase()] ?? " "
    })
    .replace(/&#(\d+);/g, (_, code: string) => {
      const value = Number(code)
      return Number.isFinite(value) ? String.fromCodePoint(value) : " "
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => {
      const value = Number.parseInt(code, 16)
      return Number.isFinite(value) ? String.fromCodePoint(value) : " "
    })
    .replace(/\s+/g, " ")
    .trim()
}
