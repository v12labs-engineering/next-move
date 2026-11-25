import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import test, { type TestContext } from "node:test"

async function runWatchdog(t: TestContext, body: string) {
  const watchdog = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { superviseApp } from "./deploy/local/app-watchdog.mjs"\n${body}`,
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  )
  t.after(() => watchdog.kill())
  let stdout = ""
  let stderr = ""
  watchdog.stdout.on("data", (chunk) => (stdout += chunk))
  watchdog.stderr.on("data", (chunk) => (stderr += chunk))
  const [code, signal] = await once(watchdog, "close")
  return { code, signal, stdout, stderr }
}

test(
  "watchdog exits for Docker to restart when an app hangs and ignores SIGTERM",
  {
    timeout: 10_000,
  },
  async (t) => {
    const watchdog = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import { superviseApp } from "./deploy/local/app-watchdog.mjs"
      let probes = 0
      globalThis.fetch = async () =>
        new Response(null, { status: ++probes <= 2 ? 200 : 503 })
      process.exitCode = await superviseApp(
        ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
        { probeIntervalMs: 50, unhealthyForMs: 250, shutdownTimeoutMs: 100 }
      )
      if (probes <= 2) process.exitCode = 2
    `,
      ],
      { stdio: ["ignore", "ignore", "pipe"] }
    )
    t.after(() => watchdog.kill())
    let log = ""
    watchdog.stderr.on("data", (chunk) => {
      log += chunk
    })

    assert.deepEqual(await once(watchdog, "close"), [1, null])
    assert.match(log, /Local app watchdog restarting Next.js/)
    assert.match(log, /unresponsive/)
  }
)

for (const exitCode of [0, 7]) {
  test(
    `watchdog preserves a child's ordinary exit code ${exitCode}`,
    {
      timeout: 10_000,
    },
    async (t) => {
      const result = await runWatchdog(
        t,
        `
      process.exitCode = await superviseApp(
        ["-e", "process.exit(${exitCode})"],
        { probeIntervalMs: 5000 }
      )
    `
      )
      assert.equal(result.code, exitCode)
      assert.equal(result.signal, null)
      assert.doesNotMatch(result.stderr, /watchdog restarting/)
    }
  )
}

for (const signal of ["SIGTERM", "SIGINT"]) {
  test(
    `watchdog forwards ${signal} and lets a healthy child drain`,
    {
      timeout: 10_000,
    },
    async (t) => {
      const result = await runWatchdog(
        t,
        `
      let probes = 0
      globalThis.fetch = async () => {
        if (++probes === 4) process.kill(process.pid, ${JSON.stringify(signal)})
        return new Response(null, { status: 200 })
      }
      process.exitCode = await superviseApp(
        ["-e", ${JSON.stringify(`
          process.on(${JSON.stringify(signal)}, () => {
            setTimeout(() => { console.log("child drained"); process.exit(0) }, 100)
          })
          setInterval(() => {}, 1000)
        `)}],
        { probeIntervalMs: 100, unhealthyForMs: 1000, shutdownTimeoutMs: 1000 }
      )
    `
      )
      assert.equal(result.code, 0)
      assert.equal(result.signal, null)
      assert.match(result.stdout, /child drained/)
      assert.doesNotMatch(result.stderr, /watchdog restarting/)
    }
  )
}

test(
  "an unexpectedly killed child produces a restartable nonzero exit",
  {
    timeout: 10_000,
  },
  async (t) => {
    const result = await runWatchdog(
      t,
      `
    process.exitCode = await superviseApp(
      ["-e", "process.kill(process.pid, 'SIGKILL')"],
      { probeIntervalMs: 5000 }
    )
  `
    )
    assert.equal(result.code, 1)
    assert.equal(result.signal, null)
  }
)

test(
  "a real loopback HTTP probe that never responds is aborted and recycles",
  {
    timeout: 20_000,
  },
  async (t) => {
    const result = await runWatchdog(
      t,
      `
    const { createServer } = await import("node:http")
    let requests = 0
    const server = createServer(() => { requests++ })
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
    try {
      process.exitCode = await superviseApp(
        ["-e", "setInterval(() => {}, 1000)"],
        {
          probeUrl: "http://127.0.0.1:" + server.address().port + "/sign-in",
          probeIntervalMs: 50,
          unhealthyForMs: 100,
          shutdownTimeoutMs: 100
        }
      )
    } finally {
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
    }
    console.log(JSON.stringify({ requests }))
  `
    )
    assert.equal(result.code, 1)
    assert.equal(result.signal, null)
    assert.match(result.stdout, /"requests":1/)
    assert.match(result.stderr, /unresponsive/)
  }
)

test(
  "healthy probes reset the grace period after repeated transient failures",
  {
    timeout: 10_000,
  },
  async (t) => {
    const result = await runWatchdog(
      t,
      `
    let probes = 0
    let elapsed = 0
    // Control elapsed time at the probe boundary so host/container contention
    // cannot turn this simulated short outage into a real long outage.
    globalThis.performance = { now: () => elapsed }
    globalThis.fetch = async () => {
      const probe = ++probes
      elapsed += 100
      if (probe === 12) process.kill(process.pid, "SIGTERM")
      // Two consecutive failures recur, but each outage ends before the grace
      // period. Total elapsed time exceeds the grace several times over.
      if (probe % 3 === 1) throw new Error("temporary connection failure")
      return new Response(null, { status: probe % 3 === 2 ? 503 : 200 })
    }
    process.exitCode = await superviseApp(
      ["-e", "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000)"],
      { probeIntervalMs: 100, unhealthyForMs: 450, shutdownTimeoutMs: 500 }
    )
    console.log(JSON.stringify({ probes }))
  `
    )
    assert.equal(result.code, 0)
    assert.equal(result.signal, null)
    assert.match(result.stdout, /"probes":12/)
    assert.doesNotMatch(result.stderr, /watchdog restarting/)
  }
)

test(
  "three real Linux RSS readings recycle an otherwise healthy child",
  {
    timeout: 10_000,
    skip: process.platform !== "linux" && "RSS watchdog uses Linux /proc",
  },
  async (t) => {
    const result = await runWatchdog(
      t,
      `
    let probes = 0
    globalThis.fetch = async () => {
      probes++
      return new Response(null, { status: 200 })
    }
    process.exitCode = await superviseApp(
      ["-e", "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000)"],
      { probeIntervalMs: 100, unhealthyForMs: 5000, shutdownTimeoutMs: 500, memoryLimitKiB: 1 }
    )
    console.log(JSON.stringify({ probes }))
  `
    )
    assert.equal(result.code, 1)
    assert.equal(result.signal, null)
    assert.match(result.stdout, /"probes":3/)
    assert.match(result.stderr, /resident_memory/)
    assert.doesNotMatch(result.stderr, /unresponsive/)
  }
)
