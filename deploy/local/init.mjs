import { createHmac, randomBytes } from "node:crypto"
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs"
import { fileURLToPath } from "node:url"

const directory = fileURLToPath(
  new URL("../../.local-data/compose/", import.meta.url)
)
mkdirSync(directory, { recursive: true, mode: 0o700 })
const path = directory + "local.env"
if (existsSync(path)) {
  if (!/^LOCAL_CRON_SECRET=/m.test(readFileSync(path, "utf8"))) {
    appendFileSync(
      path,
      `\nLOCAL_CRON_SECRET=${randomBytes(32).toString("hex")}\n`
    )
  }
  process.exit(0)
}

const secret = randomBytes(32).toString("hex")
const encode = (value) =>
  Buffer.from(JSON.stringify(value)).toString("base64url")
const jwt = (role) => {
  const header = encode({ alg: "HS256", typ: "JWT" })
  const payload = encode({
    iss: "job-search-local",
    role,
    exp: Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60,
  })
  const signature = createHmac("sha256", secret)
    .update(`${header}.${payload}`)
    .digest("base64url")
  return `${header}.${payload}.${signature}`
}

writeFileSync(
  path,
  [
    "LOCAL_URL=http://127.0.0.1:3302",
    `LOCAL_CRON_SECRET=${randomBytes(32).toString("hex")}`,
    `LOCAL_POSTGRES_PASSWORD=${randomBytes(24).toString("hex")}`,
    `LOCAL_WORKFLOW_PASSWORD=${randomBytes(24).toString("hex")}`,
    `LOCAL_JWT_SECRET=${secret}`,
    `LOCAL_ANON_KEY=${jwt("anon")}`,
    `LOCAL_SERVICE_KEY=${jwt("service_role")}`,
    "",
  ].join("\n"),
  { flag: "wx", mode: 0o600 }
)
console.log("Created local-only credentials for http://127.0.0.1:3302")
