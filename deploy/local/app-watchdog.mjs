import { spawn } from "node:child_process"
import { once } from "node:events"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

function residentKiB(pid) {
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8")
    return Number(status.match(/^VmRSS:\s+(\d+) kB/m)?.[1] ?? 0)
  } catch (error) {
    // The child can exit between probes. /proc is also absent on macOS.
    if (error.code !== "ENOENT") throw error
    return 0
  }
}

export async function superviseApp(
  args,
  {
    probeUrl = "http://127.0.0.1:3000/sign-in",
    probeIntervalMs = 10_000,
    unhealthyForMs = 90_000,
    shutdownTimeoutMs = 30_000,
    memoryLimitKiB = 3 * 1024 * 1024,
  } = {}
) {
  const child = spawn(process.execPath, args, { stdio: "inherit" })
  let lastHealthyAt = performance.now()
  let highMemoryProbes = 0
  let stopping = false
  let recycling = false
  let probeTimer
  let killTimer

  function stop(signal = "SIGTERM") {
    if (stopping) return
    stopping = true
    clearTimeout(probeTimer)
    child.kill(signal)
    killTimer = setTimeout(() => child.kill("SIGKILL"), shutdownTimeoutMs)
  }

  async function probe() {
    const rss = residentKiB(child.pid)
    highMemoryProbes = rss >= memoryLimitKiB ? highMemoryProbes + 1 : 0
    try {
      const response = await fetch(probeUrl, {
        signal: AbortSignal.timeout(3_000),
      })
      await response.body?.cancel()
      if (response.ok) lastHealthyAt = performance.now()
    } catch {
      // Consecutive failures must outlast the grace period before recycling.
    }
    if (stopping) return
    const unresponsive = performance.now() - lastHealthyAt >= unhealthyForMs
    if (unresponsive || highMemoryProbes >= 3) {
      recycling = true
      console.error("Local app watchdog restarting Next.js", {
        reason: unresponsive ? "unresponsive" : "resident_memory",
        rssKiB: rss,
      })
      stop()
      return
    }
    probeTimer = setTimeout(probe, probeIntervalMs)
  }

  const onTerminate = () => stop("SIGTERM")
  const onInterrupt = () => stop("SIGINT")
  process.on("SIGTERM", onTerminate)
  process.on("SIGINT", onInterrupt)
  probeTimer = setTimeout(probe, probeIntervalMs)

  try {
    const [code, signal] = await once(child, "exit")
    return recycling ? 1 : (code ?? (stopping && signal ? 0 : 1))
  } finally {
    stopping = true
    clearTimeout(probeTimer)
    clearTimeout(killTimer)
    process.off("SIGTERM", onTerminate)
    process.off("SIGINT", onInterrupt)
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await superviseApp([
    "--max-old-space-size=3072",
    "node_modules/next/dist/bin/next",
    "start",
    "--port",
    "3000",
    "--hostname",
    "127.0.0.1",
  ])
}
