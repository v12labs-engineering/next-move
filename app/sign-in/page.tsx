import { SignInForm } from "@/components/shell/sign-in-form"
export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>
}) {
  return <SignInForm expired={(await searchParams).error === "expired"} />
}
