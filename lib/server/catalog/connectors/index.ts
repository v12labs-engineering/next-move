import { fetchAdditionalAtsPage } from "./additional-ats"
import { fetchAmazonIndiaPage } from "./amazon"
import { fetchAccenturePage } from "./accenture"
import {
  type CatalogPosting,
  type CatalogSource,
  type FetchOptions,
  type RawSourcePosting,
} from "../feeds"
import { fetchInfoparkPage } from "./infopark"
import { fetchIndiaJobBoardPage } from "./india-job-boards"
import { fetchBoardApiPage } from "./board-apis"
import { fetchKekaPage } from "./keka"
import { fetchIbmPage } from "./ibm"
import { fetchEightfoldPage } from "./eightfold"
import { fetchTalentBrewPage } from "./talentbrew"
import { fetchSuccessFactorsPage } from "./successfactors"
import { fetchLinkedInPage } from "./linkedin"
import { fetchOracleRecruitingPage } from "./oracle-recruiting"
import { fetchPublicAtsPage } from "./public-ats"
import { boardIdentity, type BoardKind } from "../source-identity"
import { fetchZohoRecruitPage } from "./zoho-recruit"
import { fetchTeamtailorPage } from "./teamtailor"
import { fetchPersonioPage } from "./personio"
import { fetchAdzunaPage, fetchJobtechPage } from "./country-feeds"

export { parsePublicFeed } from "./public-feeds"
export type {
  PublicFeedKind,
  PublicFeedPosting,
  PublicFeedPage,
} from "./public-feeds"
export type { RawSourcePosting } from "../feeds"

export type ConnectorFamily = "ats" | "board" | "employer-site" | "park"

export interface CatalogPage {
  jobs: CatalogPosting[]
  fetched: number
  rejected: number
  requests: number
  nextPage: number | null
  employer?: string | null
  employerUrl?: string
  listingUrl?: string
}

/** One per platform. Employers on a platform are data (source rows), not code. */
export interface Connector {
  family: ConnectorFamily
  /** Source must carry a board whose canonical identity equals source.id. */
  board: boolean
  /** Identity evidence is returned by this reader alongside its postings. */
  verification?: { responseFormat(url: URL): "html" | "json" }
  fetchPage(
    source: CatalogSource,
    page: number,
    options: FetchOptions
  ): Promise<CatalogPage>
}

const ats = (
  fetchPage: Connector["fetchPage"],
  responseFormat?: (url: URL) => "html" | "json"
): Connector => ({
  family: "ats",
  board: true,
  fetchPage,
  ...(responseFormat ? { verification: { responseFormat } } : {}),
})

export const connectors = {
  greenhouse: ats(fetchBoardApiPage),
  ashby: ats(fetchBoardApiPage),
  lever: ats(fetchBoardApiPage),
  smartrecruiters: ats(fetchAdditionalAtsPage, () => "json"),
  workday: ats(fetchAdditionalAtsPage, () => "json"),
  recruitee: ats(fetchPublicAtsPage, () => "html"),
  workable: ats(fetchPublicAtsPage, () => "json"),
  keka: ats(fetchKekaPage, (url) =>
    url.pathname.includes("/api/") ? "json" : "html"
  ),
  zohorecruit: ats(fetchZohoRecruitPage, () => "html"),
  teamtailor: ats(fetchTeamtailorPage, () => "html"),
  personio: ats(fetchPersonioPage, () => "html"),
  arbeitnow: { family: "board", board: false, fetchPage: fetchBoardApiPage },
  adzuna: { family: "board", board: false, fetchPage: fetchAdzunaPage },
  jobtech: { family: "board", board: false, fetchPage: fetchJobtechPage },
  indiaboard: {
    family: "board",
    board: false,
    fetchPage: fetchIndiaJobBoardPage,
  },
  linkedin: {
    family: "board",
    board: false,
    fetchPage: (source, page, options) =>
      fetchLinkedInPage(source, page, options),
  },
  amazon: {
    family: "employer-site",
    board: false,
    fetchPage: fetchAmazonIndiaPage,
  },
  accenture: {
    family: "employer-site",
    board: false,
    fetchPage: fetchAccenturePage,
  },
  oracle: {
    family: "employer-site",
    board: false,
    fetchPage: fetchOracleRecruitingPage,
  },
  ibm: { family: "employer-site", board: false, fetchPage: fetchIbmPage },
  eightfold: {
    family: "employer-site",
    board: false,
    fetchPage: fetchEightfoldPage,
  },
  talentbrew: {
    family: "employer-site",
    board: false,
    fetchPage: fetchTalentBrewPage,
  },
  successfactors: {
    family: "employer-site",
    board: false,
    fetchPage: fetchSuccessFactorsPage,
  },
  infopark: { family: "park", board: false, fetchPage: fetchInfoparkPage },
} satisfies Record<string, Connector>

export type ConnectorKind = keyof typeof connectors

/** Source facts for research and future job categories. The existing catalog
 * projection remains available through fetchCatalogPage; it is not the raw
 * source inventory. Pagination completion is bounded by each source's scope. */
export async function fetchSourcePage(
  source: CatalogSource,
  page = 1,
  options: FetchOptions = {}
) {
  const postings: RawSourcePosting[] = []
  const snapshot = await readConnectorPage(source, page, {
    ...options,
    observePosting(posting) {
      postings.push(posting)
      options.observePosting?.(posting)
    },
  })
  return {
    postings,
    fetched: snapshot.fetched,
    requests: snapshot.requests,
    nextPage: snapshot.nextPage,
  }
}

/** One resumable page. Pagination URLs are validated, never followed blindly. */
export async function fetchCatalogPage(
  source: CatalogSource,
  page = 1,
  options: FetchOptions = {}
): Promise<CatalogPage> {
  return readConnectorPage(source, page, options)
}

async function readConnectorPage(
  source: CatalogSource,
  page: number,
  options: FetchOptions
): Promise<CatalogPage> {
  if (!Number.isSafeInteger(page) || page < 1) throw new Error("Invalid page")
  if (source.kind === "alexandria")
    throw new Error("Alexandria job sources are retired")
  if (!Object.hasOwn(connectors, source.kind))
    throw new Error("Unknown source connector")
  const connector: Connector = connectors[source.kind as ConnectorKind]
  if (
    connector.board &&
    (!source.board ||
      boardIdentity(source.kind as BoardKind, source.board).id !== source.id)
  )
    throw new Error("Invalid employer board")
  const result = await connector.fetchPage(source, page, options)
  if (
    result.nextPage !== null &&
    (!Number.isSafeInteger(result.nextPage) || result.nextPage <= page)
  )
    throw new Error("Source connector did not advance pagination")
  return result
}
