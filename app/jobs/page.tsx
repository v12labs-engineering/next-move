import { AuthGate } from "@/components/shell/auth-gate"
import { JobsPage } from "@/components/jobs/jobs-page"
export default function Page() { return <AuthGate><JobsPage /></AuthGate> }
