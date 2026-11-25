import { z } from "zod"
import { isIndiaJobBoard } from "@/lib/jobs/india-job-boards"

export const AMZ_INDIA_SOFTWARE_SOURCE = "amazon:india-software"

export const boardKinds = [
  "ashby",
  "greenhouse",
  "lever",
  "smartrecruiters",
  "workday",
  "recruitee",
  "workable",
  "keka",
  "zohorecruit",
  "teamtailor",
  "personio",
] as const
export const boardKind = z.enum(boardKinds)
export type BoardKind = z.infer<typeof boardKind>
const token = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/
const kekaHost = /^([a-z0-9][a-z0-9-]{0,62})\.keka\.com$/
const zohoHost =
  /^[a-z0-9][a-z0-9-]{0,62}\.zohorecruit\.(?:com|in|eu|com\.au|jp)$/
const teamtailorHost = /^[a-z0-9][a-z0-9-]{0,62}\.teamtailor\.com$/
const personioHost = /^[a-z0-9][a-z0-9-]{0,62}\.jobs\.personio\.(?:de|com)$/
const reservedSubdomains = ["www", "api", "app", "cdn", "help", "login", "docs"]
const workdayHost =
  /^[a-z0-9][a-z0-9-]{0,62}\.wd[0-9]{1,2}\.myworkdayjobs\.com$/

export function workdaySite(board: string) {
  const [host, site, extra] = board.split("~")
  if (
    extra !== undefined ||
    !workdayHost.test(host) ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(site ?? "")
  )
    throw new Error("Invalid Workday site")
  return { host, site, tenant: host.split(".")[0], origin: `https://${host}` }
}

export function boardIdentity(kind: BoardKind, value: string) {
  boardKind.parse(kind)
  const board = kind === "workday" ? value : value.toLowerCase()
  if (kind === "workday") workdaySite(board)
  else if (kind === "keka") {
    if (
      !kekaHost.test(`${board}.keka.com`) ||
      reservedSubdomains.includes(board)
    )
      throw new Error("Invalid employer board")
  } else if (kind === "zohorecruit") {
    if (
      !zohoHost.test(board) ||
      reservedSubdomains.includes(board.split(".")[0])
    )
      throw new Error("Invalid employer board")
  } else if (kind === "teamtailor" || kind === "personio") {
    const host = kind === "teamtailor" ? teamtailorHost : personioHost
    if (!host.test(board) || reservedSubdomains.includes(board.split(".")[0]))
      throw new Error("Invalid employer board")
  } else if (kind === "recruitee" || kind === "workable") {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(board))
      throw new Error("Invalid employer board")
  } else if (!token.test(board)) throw new Error("Invalid employer board")
  return { id: `${kind}:${board}`, kind, board }
}

export function publicBoardUrl(kind: BoardKind, value: string) {
  const { board } = boardIdentity(kind, value)
  if (kind === "workday") {
    const { origin, site } = workdaySite(board)
    return `${origin}/${site}`
  }
  if (kind === "recruitee") return `https://${board}.recruitee.com`
  if (kind === "keka") return `https://${board}.keka.com/careers`
  if (kind === "zohorecruit") return `https://${board}/jobs/Careers`
  if (kind === "teamtailor" || kind === "personio") return `https://${board}`
  const host = {
    ashby: "jobs.ashbyhq.com",
    greenhouse: "job-boards.greenhouse.io",
    lever: "jobs.lever.co",
    smartrecruiters: "careers.smartrecruiters.com",
    workable: "apply.workable.com",
  }[kind]
  return `https://${host}/${board}`
}

/** Parse observed links only; never guess employer names or follow lookalike hosts. */
export function boardFromUrl(value: string) {
  try {
    const url = new URL(value)
    if (url.protocol !== "https:" || url.port || url.username || url.password)
      return null
    const parts = url.pathname.split("/").filter(Boolean)
    const host = url.hostname
    let kind: BoardKind
    if (!reservedSubdomains.includes(host.split(".")[0])) {
      if (
        teamtailorHost.test(host) &&
        (!parts.length || /^(jobs|jobs\.rss)$/.test(parts[0]))
      )
        return boardIdentity("teamtailor", host)
      if (
        personioHost.test(host) &&
        (!parts.length || /^(job|xml)$/.test(parts[0]))
      )
        return boardIdentity("personio", host)
    }
    const keka = host.match(kekaHost)
    if (keka && parts[0] === "careers" && !reservedSubdomains.includes(keka[1]))
      return boardIdentity("keka", keka[1])
    if (
      zohoHost.test(host) &&
      ["jobs", "careers"].includes(parts[0] ?? "") &&
      !reservedSubdomains.includes(host.split(".")[0])
    )
      return boardIdentity("zohorecruit", host)
    const recruitee = host.match(/^([a-z0-9][a-z0-9-]{0,62})\.recruitee\.com$/)
    if (
      recruitee &&
      !["www", "api", "app", "docs", "support", "auth"].includes(recruitee[1])
    )
      return boardIdentity("recruitee", recruitee[1])
    if (host === "apply.workable.com") {
      if (
        !parts[0] ||
        [
          "j",
          "api",
          "auth",
          "v1",
          "v2",
          "v3",
          "login",
          "signup",
          "render",
        ].includes(parts[0])
      )
        return null
      if (
        parts.length > 1 &&
        !(parts[1] === "j" && /^[A-Fa-f0-9]{10}$/.test(parts[2] ?? ""))
      )
        return null
      return boardIdentity("workable", parts[0])
    }
    if (workdayHost.test(host)) {
      const site = /^[a-z]{2}-[A-Z]{2}$/.test(parts[0] ?? "")
        ? parts[1]
        : parts[0]
      return site ? boardIdentity("workday", `${host}~${site}`) : null
    }
    if (host === "jobs.ashbyhq.com") kind = "ashby"
    else if (
      [
        "boards.greenhouse.io",
        "boards.eu.greenhouse.io",
        "job-boards.greenhouse.io",
        "job-boards.eu.greenhouse.io",
      ].includes(host)
    )
      kind = "greenhouse"
    else if (["jobs.lever.co", "jobs.eu.lever.co"].includes(host))
      kind = "lever"
    else if (
      ["jobs.smartrecruiters.com", "careers.smartrecruiters.com"].includes(host)
    )
      kind = "smartrecruiters"
    else return null
    return parts[0] ? boardIdentity(kind, parts[0]) : null
  } catch {
    return null
  }
}

export function validSourceId(id: string) {
  if (id.startsWith("indiaboard:")) return isIndiaJobBoard(id.slice(11))
  if (
    [
      "linkedin",
      AMZ_INDIA_SOFTWARE_SOURCE,
      "infopark:kerala",
      "oracle:bny",
      "oracle:ibs-software",
      "oracle:oracle-india",
      "oracle:jpmorgan-chase",
      "oracle:honeywell",
      "oracle:nokia",
      "oracle:emerson",
      "ibm:india",
      "eightfold:qualcomm-india",
      "talentbrew:barclays-india",
      "successfactors:deloitte-india",
    ].includes(id)
  )
    return true
  if (
    /^adzuna:(at|au|be|br|ca|ch|de|es|fr|gb|in|it|mx|nl|nz|pl|sg|us|za)$/.test(
      id
    ) ||
    id === "jobtech:se"
  )
    return true
  const split = id.indexOf(":")
  if (split < 0) return false
  try {
    const identity = boardIdentity(
      boardKind.parse(id.slice(0, split)),
      id.slice(split + 1)
    )
    return identity.id === id
  } catch {
    return false
  }
}

export function providerHost(host: string) {
  return (
    workdayHost.test(host) ||
    /^[a-z0-9][a-z0-9-]{0,62}\.recruitee\.com$/.test(host) ||
    ((kekaHost.test(host) ||
      zohoHost.test(host) ||
      teamtailorHost.test(host) ||
      personioHost.test(host)) &&
      !reservedSubdomains.includes(host.split(".")[0])) ||
    [
      "boards-api.eu.greenhouse.io",
      "boards.eu.greenhouse.io",
      "job-boards.eu.greenhouse.io",
      "api.eu.lever.co",
      "jobs.eu.lever.co",
      "api.smartrecruiters.com",
      "careers.smartrecruiters.com",
      "jobs.smartrecruiters.com",
      "apply.workable.com",
    ].includes(host)
  )
}
