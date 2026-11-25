"use client"
import { useState } from "react"
import { Building2 } from "lucide-react"
import { companyDomain, platformSlug } from "@/lib/jobs/company-logo"
import { cn } from "@/lib/utils"

/** Company logo via our own proxy (no third party sees the user). */
export function CompanyMark({
  name,
  url,
  className,
}: {
  name: string
  url?: string
  className?: string
}) {
  const [failed, setFailed] = useState(false)
  const hint = url ? (companyDomain(url) ?? platformSlug(url)) : null
  const query = new URLSearchParams({ name, ...(hint ? { hint } : {}) })
  const box = cn(
    "flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-lg",
    className
  )
  if (failed)
    return (
      <span aria-hidden className={cn(box, "bg-muted text-muted-foreground")}>
        <Building2 className="size-[60%]" />
      </span>
    )
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`/api/company-logo?${query}`}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
      className={cn(box, "bg-white object-contain p-0.5 ring-1 ring-border")}
    />
  )
}
