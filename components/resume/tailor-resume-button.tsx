"use client"
import { useState } from "react"
import { useRouter } from "next/navigation"
import { LoaderCircle, Sparkles } from "lucide-react"
import { Button } from "@/components/ui/button"
export function TailorResumeButton({ jobId }: { jobId: string }) {
  const router = useRouter()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState("")
  return (
    <div className="space-y-3">
      <Button
        size="lg"
        disabled={pending}
        aria-busy={pending}
        onClick={async () => {
          setPending(true)
          setError("")
          try {
            const response = await fetch("/api/resumes", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ jobId }),
            })
            const data = await response.json()
            if (!response.ok)
              throw new Error(data.error ?? "Could not create a draft.")
            router.push(`/resumes/${data.id}`)
          } catch (err) {
            setError(err instanceof Error ? err.message : "Tailoring failed.")
          } finally {
            setPending(false)
          }
        }}
      >
        {pending ? (
          <LoaderCircle className="size-4 animate-spin" aria-hidden />
        ) : (
          <Sparkles className="size-4" aria-hidden />
        )}
        {pending ? "Checking job keywords…" : "Create tailored draft"}
      </Button>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
