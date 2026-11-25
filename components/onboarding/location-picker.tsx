"use client"

import { useEffect, useId, useRef, useState } from "react"
import type { TargetLocation } from "@/lib/candidate"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

export function LocationPicker({
  country,
  selected,
  onAdd,
  onRemove,
}: {
  country: string
  selected: TargetLocation[]
  onAdd: (location: TargetLocation) => void
  onRemove: (id: number) => void
}) {
  const id = useId()
  const listRef = useRef<HTMLUListElement>(null)
  const [query, setQuery] = useState("")
  const [results, setResults] = useState<TargetLocation[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  useEffect(() => {
    listRef.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" })
  }, [active])
  useEffect(() => {
    if (query.trim().length < 2) return
    const controller = new AbortController()
    const timer = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ country, q: query.trim() })
        const response = await fetch(`/api/locations?${params}`, {
          signal: controller.signal,
        })
        const data = await response.json()
        if (controller.signal.aborted) return
        if (!response.ok)
          throw new Error(data.error ?? "Could not search locations.")
        setResults(data.locations)
      } catch (err) {
        if (!controller.signal.aborted)
          setError(
            err instanceof Error ? err.message : "Could not search locations."
          )
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    }, 350)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [country, query])
  const options = results.filter(
    (place) => !selected.some((item) => item.id === place.id)
  )
  function choose(place: TargetLocation) {
    onAdd(place)
    setQuery("")
    setResults([])
    setLoading(false)
    setOpen(false)
    setActive(-1)
  }
  const expanded = open && query.trim().length >= 2
  return (
    <div className="space-y-3">
      <Label htmlFor={id}>Locations in {country} (optional)</Label>
      <p id={`${id}-help`} className="text-xs text-muted-foreground">
        {selected.length
          ? "Matches use these locations. Remove all to search the whole country."
          : "Anywhere in this country. Search to narrow to specific cities or towns."}
      </p>
      <div className="relative">
        <Input
          id={id}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={expanded}
          aria-controls={expanded ? `${id}-options` : undefined}
          aria-activedescendant={
            expanded && active >= 0 && options[active]
              ? `${id}-option-${active}`
              : undefined
          }
          aria-describedby={`${id}-help ${id}-status`}
          autoComplete="off"
          placeholder={`Search cities in ${country}`}
          value={query}
          maxLength={80}
          disabled={selected.length >= 5}
          onChange={(e) => {
            const value = e.target.value
            setQuery(value)
            setResults([])
            setError("")
            setLoading(value.trim().length >= 2)
            setOpen(true)
            setActive(-1)
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault()
              setOpen(true)
              setActive((index) =>
                e.key === "ArrowDown"
                  ? Math.min(index + 1, options.length - 1)
                  : Math.max(index - 1, 0)
              )
            } else if (e.key === "Enter") {
              e.preventDefault()
              if (expanded && options[active]) choose(options[active])
            } else if (e.key === "Escape") {
              e.preventDefault()
              setOpen(false)
            }
          }}
        />
        {expanded && (
          <ul
            ref={listRef}
            id={`${id}-options`}
            role="listbox"
            aria-label={`Locations in ${country}`}
            className="absolute z-30 mt-1 max-h-56 w-full overflow-y-auto rounded-xl border bg-popover p-1 text-popover-foreground shadow-lg"
          >
            {!options.length && (
              <li
                role="presentation"
                className="px-3 py-2 text-sm text-muted-foreground"
              >
                {error ||
                  (loading
                    ? "Searching locations…"
                    : "No locations found. Try another city or town name.")}
              </li>
            )}
            {options.map((place, index) => (
              <li
                key={place.id}
                id={`${id}-option-${index}`}
                role="option"
                aria-selected={active === index}
                className={`cursor-pointer rounded-md px-3 py-2 text-sm hover:bg-accent ${active === index ? "bg-accent" : ""}`}
                onMouseDown={(e) => e.preventDefault()}
                onMouseMove={() => setActive(index)}
                onClick={() => choose(place)}
              >
                {place.name}
                {place.region ? `, ${place.region}` : ""}
              </li>
            ))}
          </ul>
        )}
      </div>
      <p
        id={`${id}-status`}
        role="status"
        className="text-xs text-muted-foreground"
      >
        {error ||
          (loading
            ? "Searching locations…"
            : expanded && !options.length
              ? "No locations found. Try another city or town name."
              : selected.length >= 5
                ? "Up to 5 locations per country."
                : "")}
      </p>
      {selected.length > 0 && (
        <ul
          className="flex flex-wrap gap-2"
          aria-label={`Selected locations in ${country}`}
        >
          {selected.map((place) => (
            <li key={place.id}>
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-label={`Remove ${place.name}${place.region ? `, ${place.region}` : ""} from ${country}`}
                onClick={() => onRemove(place.id)}
              >
                {place.name}
                {place.region ? `, ${place.region}` : ""}{" "}
                <span aria-hidden="true">×</span>
              </Button>
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">
        Location search by{" "}
        <a
          href="https://open-meteo.com/en/docs/geocoding-api"
          target="_blank"
          rel="noreferrer"
          className="underline"
        >
          Open-Meteo
        </a>{" "}
        /{" "}
        <a
          href="https://www.geonames.org/"
          target="_blank"
          rel="noreferrer"
          className="underline"
        >
          GeoNames
        </a>
        .
      </p>
    </div>
  )
}
