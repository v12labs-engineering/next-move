/** Keyset traversal avoids dropping relevant jobs behind an arbitrary row cap. */
export async function scanCatalog<T extends { id: string }>(
  fetchPage: (after: string | null) => Promise<T[]>,
  consume: (page: T[]) => void | Promise<void>
) {
  let after: string | null = null
  const visited = new Set<string>()
  for (;;) {
    const page = await fetchPage(after)
    if (!page.length) return
    const next = page.at(-1)!.id
    if (visited.has(next))
      throw new Error(
        "Catalogue traversal did not advance; coverage is incomplete."
      )
    await consume(page)
    visited.add(next)
    after = next
  }
}
