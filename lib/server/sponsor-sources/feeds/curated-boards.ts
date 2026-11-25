import type { CuratedBoard } from "@/lib/server/sponsor-sources/feeds/job-feeds"

/**
 * Curated EU AI / scaleup employers with PUBLIC ATS board APIs. These return
 * every open role as clean JSON — the highest-signal source for founding/staff
 * product + AI roles in target countries. Slugs verified live against the
 * Greenhouse / Lever / Ashby board APIs.
 *
 * `country` is the company's primary EU hub; per-job location parsing overrides
 * it when a posting names a specific city (so a US-HQ company's Berlin role
 * lands in Germany, etc.).
 */
export const CURATED_BOARDS: CuratedBoard[] = [
  // ---- AI-native (top priority for Applied AI / Founding Engineer) ----
  { company: "Mistral AI", ats: "lever", slug: "mistral", country: "France" },
  { company: "Hugging Face", ats: "greenhouse", slug: "huggingface", country: "France" },
  { company: "Dust", ats: "ashby", slug: "dust", country: "France" },
  { company: "Photoroom", ats: "ashby", slug: "photoroom", country: "France" },
  { company: "Synthesia", ats: "ashby", slug: "synthesia", country: "Germany" },
  { company: "Cohere", ats: "ashby", slug: "cohere", country: "Germany" },
  { company: "Lovable", ats: "ashby", slug: "lovable", country: "Sweden" },
  { company: "DeepL", ats: "ashby", slug: "deepl", country: "Germany" },
  { company: "Helsing", ats: "ashby", slug: "helsing", country: "Germany" },
  { company: "Perplexity", ats: "ashby", slug: "perplexity", country: "Germany" },
  { company: "Poolside", ats: "ashby", slug: "poolside", country: "France" },
  { company: "Tractable", ats: "ashby", slug: "tractable", country: "Ireland" },
  { company: "Modal", ats: "ashby", slug: "modal", country: "Germany" },
  { company: "Granola", ats: "ashby", slug: "granola", country: "Germany" },
  { company: "Mintlify", ats: "ashby", slug: "mintlify", country: "Germany" },
  { company: "Runway", ats: "ashby", slug: "runway", country: "Germany" },
  { company: "Browserbase", ats: "ashby", slug: "browserbase", country: "Germany" },
  { company: "Linear", ats: "ashby", slug: "linear", country: "Germany" },

  // ---- EU scaleups / strong international hiring ----
  { company: "Datadog", ats: "greenhouse", slug: "datadog", country: "France" },
  { company: "GitLab", ats: "greenhouse", slug: "gitlab", country: "Netherlands" },
  { company: "Celonis", ats: "greenhouse", slug: "celonis", country: "Germany" },
  { company: "GoCardless", ats: "greenhouse", slug: "gocardless", country: "Ireland" },
  { company: "SumUp", ats: "greenhouse", slug: "sumup", country: "Germany" },
  { company: "Contentful", ats: "greenhouse", slug: "contentful", country: "Germany" },
  { company: "GetYourGuide", ats: "greenhouse", slug: "getyourguide", country: "Germany" },
  { company: "Trivago", ats: "greenhouse", slug: "trivago", country: "Germany" },
  { company: "HelloFresh", ats: "greenhouse", slug: "hellofresh", country: "Germany" },
  { company: "Monzo", ats: "greenhouse", slug: "monzo", country: "Ireland" },
  { company: "Raisin", ats: "greenhouse", slug: "raisin", country: "Germany" },
  { company: "Solaris", ats: "greenhouse", slug: "solarisbank", country: "Germany" },
  { company: "Typeform", ats: "greenhouse", slug: "typeform", country: "Spain" },
  { company: "Cabify", ats: "greenhouse", slug: "cabify", country: "Spain" },
  { company: "Pigment", ats: "lever", slug: "pigment", country: "France" },
  { company: "Swile", ats: "lever", slug: "swile", country: "France" },
  { company: "Spotify", ats: "lever", slug: "spotify", country: "Sweden" },
  { company: "Ramp", ats: "ashby", slug: "ramp", country: "Ireland" },

  // ---- EU fintech / health / scaleups (verified, high volume) ----
  { company: "Adyen", ats: "greenhouse", slug: "adyen", country: "Netherlands" },
  { company: "Doctolib", ats: "greenhouse", slug: "doctolib", country: "France" },
  { company: "N26", ats: "greenhouse", slug: "n26", country: "Germany" },
  { company: "Pennylane", ats: "ashby", slug: "pennylane", country: "France" },
  { company: "Contentsquare", ats: "lever", slug: "contentsquare", country: "France" },
  { company: "Truecaller", ats: "greenhouse", slug: "truecaller", country: "Sweden" },
  { company: "Remote", ats: "greenhouse", slug: "remote", country: "Portugal" },
]
