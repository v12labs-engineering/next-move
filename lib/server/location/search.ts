import { z } from "zod"
import { countryCode, countryName } from "@/lib/location/countries"
import type { TargetLocation } from "@/lib/candidate"
import { HttpError } from "@/lib/server/http"

export const locationSearchSchema = z.object({
  country: z
    .string()
    .trim()
    .min(2)
    .max(100)
    .refine((value) => Boolean(countryCode(value))),
  q: z.string().trim().min(2).max(80),
})
const responseSchema = z.object({
  results: z
    .array(
      z.object({
        id: z.number().int().positive().safe(),
        name: z.string().min(1).max(120),
        country_code: z.string(),
        admin1: z.string().min(1).max(120).optional(),
        feature_code: z.string(),
      })
    )
    .max(20)
    .optional(),
})

export async function searchLocations(
  input: unknown
): Promise<TargetLocation[]> {
  const { country, q } = locationSearchSchema.parse(input)
  const code = countryCode(country)!
  const url = new URL("https://geocoding-api.open-meteo.com/v1/search")
  url.searchParams.set("name", q)
  url.searchParams.set("countryCode", code)
  url.searchParams.set("count", "20")
  url.searchParams.set("language", "en")
  try {
    const response = await fetch(url, {
      cache: "no-store",
      signal: AbortSignal.timeout(6000),
    })
    if (!response.ok) throw new Error("Geocoding failed")
    const data = responseSchema.parse(await response.json())
    const locations = (data.results ?? [])
      .filter(
        (place) =>
          place.country_code.toUpperCase() === code &&
          place.feature_code.startsWith("PPL")
      )
      .map((place) => ({
        id: place.id,
        country: countryName(country)!,
        name: place.name,
        region: place.admin1 ?? null,
      }))
    return [...new Map(locations.map((place) => [place.id, place])).values()]
  } catch {
    throw new HttpError(
      503,
      "Location search is unavailable. Please try again."
    )
  }
}
