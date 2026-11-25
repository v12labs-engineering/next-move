import {
  ShieldAlert,
  ShieldCheck,
  ShieldEllipsis,
  ShieldHalf,
  ShieldX,
} from "lucide-react"

import { visaLabels, type VisaConfidence } from "@/lib/location/relocation-data"
import { cn } from "@/lib/utils"

export const visaSignalStyles: Record<
  VisaConfidence,
  { icon: typeof ShieldCheck; tone: string }
> = {
  confirmed: {
    icon: ShieldCheck,
    tone: "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
  },
  strong: {
    icon: ShieldHalf,
    tone: "bg-sky-500/12 text-sky-700 dark:text-sky-300",
  },
  possible: {
    icon: ShieldEllipsis,
    tone: "bg-amber-500/14 text-amber-700 dark:text-amber-300",
  },
  weak: {
    icon: ShieldAlert,
    tone: "bg-orange-500/12 text-orange-700 dark:text-orange-300",
  },
  no: { icon: ShieldX, tone: "bg-red-500/12 text-red-700 dark:text-red-300" },
}

/** Visa likelihood as glyph + tone + label, never color alone. */
export function VisaSignal({
  value,
  className,
}: {
  value: VisaConfidence
  className?: string
}) {
  const { icon: Icon, tone } = visaSignalStyles[value]
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center gap-1.5 rounded-md px-2 text-xs font-medium",
        tone,
        className
      )}
    >
      <Icon className="size-3.5" />
      {visaLabels[value]}
      <span className="sr-only"> visa signal</span>
    </span>
  )
}
