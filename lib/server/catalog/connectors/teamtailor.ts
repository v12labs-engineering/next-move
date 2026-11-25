import { load } from "cheerio"
import { SaxesParser } from "saxes"
import { catalogRoleTitleScope, isCatalogRole } from "../../../jobs/categories"
import {
  catalogDate,
  catalogPosting,
  catalogText,
  explicitCountry,
  plain,
  type CatalogPosting,
  type CatalogSource,
  type FetchOptions,
} from "../feeds"
import { boardIdentity, publicBoardUrl } from "../source-identity"

const pageSize = 100
const maxPostings = 5000

function readFeed(text: string, origin: string) {
  // An HTML challenge or repaired, truncated XML is not an empty inventory.
  const parser = new SaxesParser()
  parser.on("doctype", () => {
    throw new Error("Teamtailor feed must not contain a DTD")
  })
  parser.write(text).close()
  const $ = load(text, { xml: true })
  const rss = $.root().children()
  if (
    rss.length !== 1 ||
    rss[0]?.tagName !== "rss" ||
    rss.children().length !== 1 ||
    rss.children("channel").length !== 1 ||
    $("channel").length !== 1 ||
    rss.attr("xmlns:tt") !== "https://teamtailor.com/locations"
  )
    throw new Error("Invalid Teamtailor RSS inventory")
  const channel = rss.children("channel")
  const metadata = new Set([
    "title",
    "description",
    "link",
    "item",
    "language",
    "copyright",
    "managingEditor",
    "webMaster",
    "pubDate",
    "lastBuildDate",
    "category",
    "generator",
    "docs",
    "cloud",
    "ttl",
    "image",
    "rating",
    "textInput",
    "skipHours",
    "skipDays",
  ])
  if (
    channel
      .children()
      .toArray()
      .some((node) => !metadata.has(node.tagName))
  )
    throw new Error("Unexpected Teamtailor inventory field")
  function field(node: typeof channel, key: string) {
    const values = node.children(key)
    if (values.length > 1) throw new Error("Duplicate Teamtailor feed field")
    return values.text().trim()
  }
  const employer = field(channel, "title")
  if (!employer || employer.length > 300)
    throw new Error("Teamtailor employer identity unavailable")
  const channelUrl = URL.parse(field(channel, "link"))
  if (
    !channelUrl ||
    channelUrl.origin !== origin ||
    channelUrl.username ||
    channelUrl.password ||
    channelUrl.pathname !== "/jobs" ||
    channelUrl.search ||
    channelUrl.hash
  )
    throw new Error("Teamtailor feed identity differs from employer board")
  const nodes = channel.children("item")
  if (nodes.length > pageSize || $("item").length !== nodes.length)
    throw new Error("Invalid Teamtailor page inventory")
  const seenIds = new Set<string>()
  const seenUrls = new Set<string>()
  const items = nodes.toArray().map((node) => {
    const item = $(node)
    const get = (key: string) => field(item, key)
    const guid = get("guid")
    const title = get("title")
    const url = URL.parse(get("link"))
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        guid
      ) ||
      !title ||
      !url ||
      url.origin !== origin ||
      url.username ||
      url.password ||
      !/^\/jobs\/[1-9]\d*(?:-[\p{L}\p{N}%._~-]+)?$/u.test(url.pathname) ||
      url.search ||
      url.hash
    )
      throw new Error("Invalid Teamtailor posting identity")
    const jobId = url.pathname.match(/^\/jobs\/(\d+)/)![1]
    if (seenIds.has(guid) || seenUrls.has(jobId))
      throw new Error("Duplicate Teamtailor posting")
    seenIds.add(guid)
    seenUrls.add(jobId)
    const containers = item.children("tt\\:locations")
    if (containers.length > 1)
      throw new Error("Duplicate Teamtailor locations field")
    const locations = containers
      .children("tt\\:location")
      .toArray()
      .map((location) => ({
        name: field($(location), "tt\\:name"),
        city: field($(location), "tt\\:city"),
        country: field($(location), "tt\\:country"),
      }))
    const remote = get("remoteStatus")
    const workMode: CatalogPosting["work_mode"] =
      remote === "fully" ? "remote" : remote === "hybrid" ? "hybrid" : "unknown"
    return {
      guid,
      jobId,
      title,
      url: url.href,
      description: plain(get("description")),
      postedAt: catalogDate(get("pubDate") || undefined),
      workMode,
      locations,
    }
  })
  return { employer, items }
}

/** Teamtailor's documented RSS inventory uses offset/per_page. A short page
 * completes the inventory; reaching a safety cap never does. */
export async function fetchTeamtailorPage(
  source: CatalogSource,
  page: number,
  options: FetchOptions = {}
) {
  if (
    source.kind !== "teamtailor" ||
    !source.board ||
    !Number.isSafeInteger(page) ||
    page < 1 ||
    page > maxPostings / pageSize + 1 ||
    boardIdentity("teamtailor", source.board).id !== source.id
  )
    throw new Error("Invalid Teamtailor source or page")
  const origin = publicBoardUrl("teamtailor", source.board)
  const feedUrl = (number: number) =>
    `${origin}/jobs.rss?offset=${(number - 1) * pageSize}&per_page=${pageSize}`
  const listingUrl = feedUrl(page)
  let requests = 0
  const request = {
    ...options,
    onRequest() {
      requests++
      options.onRequest?.()
    },
  }
  const current = readFeed(await catalogText(listingUrl, request), origin)
  if (source.company && source.company !== current.employer)
    throw new Error("Teamtailor employer changed; revalidation required")
  if ((page - 1) * pageSize + current.items.length > maxPostings)
    throw new Error("Teamtailor inventory exceeds the safety limit")
  if (page > 1) {
    // Checking the boundary also catches providers that ignore offset. No
    // cross-request memory is needed when a durable worker resumes a page.
    const previous = readFeed(
      await catalogText(feedUrl(page - 1), request),
      origin
    )
    const previousIds = new Set(previous.items.map((item) => item.guid))
    const previousJobs = new Set(previous.items.map((item) => item.jobId))
    if (
      previous.employer !== current.employer ||
      previous.items.length !== pageSize ||
      current.items.some(
        (item) => previousIds.has(item.guid) || previousJobs.has(item.jobId)
      )
    )
      throw new Error(
        "Teamtailor inventory changed or pagination did not advance"
      )
  }
  const jobs: CatalogPosting[] = []
  let accepted = 0
  for (const item of current.items) {
    const countries = new Map<string, Set<string>>()
    for (const location of item.locations) {
      const country = explicitCountry(location.country)
      if (!country) continue
      const cities = countries.get(country) ?? new Set<string>()
      if (location.city) cities.add(location.city)
      countries.set(country, cities)
    }
    options.observePosting?.({
      title: item.title,
      company: current.employer,
      url: item.url,
      description: item.description,
      locations: item.locations
        .map((loc) =>
          [loc.city || loc.name, loc.country].filter(Boolean).join(", ")
        )
        .filter(Boolean),
      countries: [...countries.keys()],
      postedAt: item.postedAt,
    })
    if (!options.observePosting) {
      const categories = options.jobCategories ?? ["software"]
      if (
        catalogRoleTitleScope(item.title, categories) !== "excluded" &&
        item.description.length < 100
      )
        throw new Error("Teamtailor description is incomplete")
      if (
        isCatalogRole(item.title, item.description, categories) &&
        !countries.size
      )
        throw new Error("Teamtailor eligible posting lacks country evidence")
    }
    let kept = false
    for (const [country, cities] of countries) {
      const posting = catalogPosting(
        {
          title: item.title,
          company: current.employer,
          country,
          city: [...cities].join("; ") || null,
          url: item.url,
          description: item.description,
          work_mode: item.workMode,
          source: source.id,
          posted_at: item.postedAt,
        },
        undefined,
        options.jobCategories
      )
      if (posting) {
        jobs.push(posting)
        kept = true
      }
    }
    if (kept) accepted++
  }
  return {
    jobs,
    fetched: current.items.length,
    rejected: current.items.length - accepted,
    requests,
    nextPage: current.items.length === pageSize ? page + 1 : null,
    employer: current.employer,
    employerUrl: listingUrl,
    listingUrl,
  }
}
