import { requirePageAccount } from "@/lib/server/session"
import { ApplicationQuestionLibrary } from "@/components/applications/application-question-library"
export default async function Page() {
  await requirePageAccount()
  return <ApplicationQuestionLibrary />
}
