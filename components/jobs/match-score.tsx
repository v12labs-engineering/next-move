"use client"
import { useEffect, useState } from "react"

import { cn } from "@/lib/utils"

function bandOf(value: number) {
  if (value >= 70)
    return {
      label: "Strong match",
      tone: "text-emerald-600 dark:text-emerald-400",
    }
  if (value >= 45)
    return {
      label: "Possible match",
      tone: "text-amber-600 dark:text-amber-400",
    }
  return { label: "Weak match", tone: "text-muted-foreground" }
}

/** Fit score as a small ring, so ranking is visible at a glance. */
export function MatchScore({
  score,
  reasons = [],
  gaps = [],
  className,
}: {
  score: number
  reasons?: string[]
  gaps?: string[]
  className?: string
}) {
  const value = Math.max(0, Math.min(100, Math.round(score)))
  const circumference = 2 * Math.PI * 14
  const band = bandOf(value)
  const [shown, setShown] = useState(0)
  useEffect(() => {
    const frame = requestAnimationFrame(() => setShown(value))
    return () => cancelAnimationFrame(frame)
  }, [value])
  const title = [
    `Match score ${value}/100 · ${band.label}`,
    ...reasons.slice(0, 4).map((reason) => `+ ${reason}`),
    ...gaps.slice(0, 3).map((gap) => `– ${gap}`),
  ].join("\n")
  return (
    <span
      role="img"
      aria-label={`Match score ${value} out of 100, ${band.label.toLowerCase()}`}
      title={title}
      className={cn(
        "relative inline-flex size-9 shrink-0 items-center justify-center",
        band.tone,
        className
      )}
    >
      <svg viewBox="0 0 32 32" className="absolute inset-0 -rotate-90">
        <circle
          cx="16"
          cy="16"
          r="14"
          fill="none"
          strokeWidth="2.5"
          className="stroke-muted"
        />
        <circle
          cx="16"
          cy="16"
          r="14"
          fill="none"
          strokeWidth="2.5"
          strokeLinecap="round"
          stroke="currentColor"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - shown / 100)}
          className="motion-safe:transition-[stroke-dashoffset] motion-safe:duration-700 motion-safe:ease-out-expo"
        />
      </svg>
      <span className="text-[10px] font-semibold tabular-nums">{value}</span>
    </span>
  )
}
