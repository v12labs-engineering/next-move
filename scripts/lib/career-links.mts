import type { CheerioAPI } from "cheerio"
import { publicApplicationUrl } from "@/lib/applications/url"
import { boardFromUrl } from "@/lib/server/catalog/source-identity"

const careerLabel =
  /^(?:careers?|jobs|job openings?|join (?:us|our team)|work with us|work at .{2,100}|view (?:all )?(?:jobs|open (?:jobs|roles|positions))|see (?:all )?(?:jobs|open (?:roles|positions))|open (?:roles|positions)|current (?:openings|vacancies))\b/i

export function employerCareerLink(website: URL, value: string) {
  const safe = publicApplicationUrl(value)
  if (!safe) return false
  const target = new URL(safe)
  const domain = website.hostname.replace(/^www\./, "")
  return (
    (target.hostname === domain || target.hostname.endsWith(`.${domain}`)) &&
    (/^careers?\.|^jobs\./i.test(target.hostname) ||
      /\/(careers?|jobs|job-openings|current-openings|join-us|work-with-us)(?:[/.-]|$)/i.test(
        target.pathname
      ))
  )
}

export function publishedCareerLinks(page: URL, $: CheerioAPI) {
  const links = new Set<string>()
  $("a[href]").each((_, link) => {
    const href = $(link).attr("href")
    if (!href || href.startsWith("#")) return
    const label = $(link).text().replace(/\s+/g, " ").trim()
    const target = URL.parse(href.trim(), page)
    if (
      !target ||
      !publicApplicationUrl(target.href) ||
      !careerLabel.test(label)
    )
      return
    target.hash = ""
    if (
      target.href !== page.href &&
      (employerCareerLink(page, target.href) || boardFromUrl(target.href))
    )
      links.add(target.href)
  })
  return [...links]
}
