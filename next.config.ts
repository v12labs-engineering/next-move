import { dirname } from "node:path"
import { fileURLToPath } from "node:url"

import type { NextConfig } from "next"
import { withWorkflow } from "workflow/next"

const workspaceRoot = dirname(fileURLToPath(import.meta.url))

const nextConfig: NextConfig = {
  outputFileTracingIncludes: {
    "/*": [
      "./skills/resume-preparation/SKILL.md",
      "./workers/browser-use/agent.py",
      "./workers/browser-use/server.py",
      "./workers/browser-use/boat_server.py",
      "./workers/browser-use/tool_models.py",
      "./workers/browser-use/requirements.txt",
      "./workers/browser-use/captcha-worker.mjs",
    ],
  },
  outputFileTracingExcludes: {
    "/*": ["./.local-data/**/*", "./.env*", "./.git/**/*"],
  },
  turbopack: {
    root: workspaceRoot,
  },
}

export default withWorkflow(nextConfig)
