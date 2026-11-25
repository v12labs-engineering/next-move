import { requirePageAccount } from "@/lib/server/session"
import { ApplicationReview } from "@/components/applications/application-review"
export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  await requirePageAccount()
  return (
    <ApplicationReview
      id={(await params).id}
      followupEnabled={Boolean(process.env.FIRECRAWL_API_KEY?.trim())}
    />
  )
}
