// Explicit live diagnostic: runs a small prompt and logs timing/counts only.
// Credentials stay in memory; prompts, reasoning and account tokens are not logged.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { performance } from "node:perf_hooks"
import { CodeBuddySession, openCodeBuddySession, promptSession } from "../acp.mjs"
import { findCodebuddy, codebuddyLaunchArgs } from "../platform.mjs"
import { CodeBuddyCliPlugin, _internal } from "../index.mjs"

const args = process.argv.slice(2)
const option = (name, fallback) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback
const modes = args.filter((arg) => !arg.startsWith("--"))
const model = option("model", "deepseek-v4.1-flash")
const effort = option("effort", "high")
const timeoutMs = Number(option("timeout", "180000"))
const homeConfig = path.join(os.homedir(), ".config", "magpie")
const store = JSON.parse(fs.readFileSync(path.join(homeConfig, "plugin-auth.json"), "utf8"))
const accountId = option("account", "codebuddy-cli")
const auth = store[accountId]
const token = auth?.access ?? auth?.key
if (!token) throw new Error("The selected configured account has no token")
const prompt = "不要调用任何工具。计算满足 0≤a<b<c≤40 且 a+b+c=57 的整数三元组数量。给出结果和简短的计算方法。"
const body = { model: `codebuddy-cli/${model}`, max_tokens: 32768, stream: true,
  thinking: { type: "enabled", budget_tokens: 16384 }, output_config: { effort },
  messages: [{ role: "user", content: prompt }] }

let active
const originalPush = CodeBuddySession.prototype.push
CodeBuddySession.prototype.push = function (event) {
  if (active && ["text", "thinking", "turn-end", "turn-error", "builtin-tool", "tool-call"].includes(event.type)) {
    active.mark(`acp:${event.type}`, event.text?.length ?? 0)
  }
  return originalPush.call(this, event)
}

function timing(mode) {
  const started = performance.now()
  const counts = {}
  const first = {}
  let lastContent
  let largestContentGapMs = 0
  const mark = (stage, size = 0) => {
    const ms = Math.round(performance.now() - started)
    counts[stage] = (counts[stage] ?? 0) + 1
    if (stage.includes("thinking") || stage.endsWith(":text") || stage.endsWith(":text_delta")) {
      if (lastContent !== undefined) largestContentGapMs = Math.max(largestContentGapMs, ms - lastContent)
      lastContent = ms
    }
    if (!(stage in first)) {
      first[stage] = ms
      console.log(JSON.stringify({ mode, stage, ms, size }))
    }
  }
  return { mark, summary: () => console.log(JSON.stringify({ mode, model, effort, first, counts,
    largestContentGapMs, totalMs: Math.round(performance.now() - started) })) }
}

async function readStream(response, tracker) {
  tracker.mark(`http:${response.status}`)
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    tracker.mark("http:bytes", value.length)
    buffer += decoder.decode(value, { stream: true })
    for (;;) {
      const end = buffer.indexOf("\n\n")
      if (end < 0) break
      const frame = buffer.slice(0, end)
      buffer = buffer.slice(end + 2)
      const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n")
      if (!data || data === "[DONE]") continue
      let event
      try { event = JSON.parse(data) } catch { continue }
      const kind = event.delta?.type ?? event.type
      tracker.mark(`sse:${kind}`, event.delta?.thinking?.length ?? event.delta?.text?.length ?? 0)
    }
  }
}

async function run(mode) {
  const tracker = timing(mode)
  active = mode === "gateway" ? null : tracker
  const signal = AbortSignal.timeout(timeoutMs)
  console.log(JSON.stringify({ mode, model, effort, account: mode === "gateway" ? "gateway routing" : accountId, begin: new Date().toISOString() }))
  try {
    if (mode === "acp") {
      const launch = await findCodebuddy()
      if (!launch) throw new Error("CodeBuddy CLI not found")
      const session = await openCodeBuddySession({ launch, argv: codebuddyLaunchArgs({ model, effort,
        sessionPersistence: false, permissionMode: "default" }), cwd: process.cwd(), env: _internal.childEnv(token) })
      tracker.mark("session:ready")
      session.setPermissionDecider(() => null)
      try {
        await promptSession(session, [{ type: "text", text: prompt }], { signal })
        tracker.mark("acp:turn-end")
      } finally { await session.stop() }
    } else if (mode === "plugin") {
      const hooks = await CodeBuddyCliPlugin()
      try {
        const loader = await hooks.auth.loader(async () => auth)
        await readStream(await loader.fetch("codebuddy-cli://local/v1/messages", { method: "POST",
          headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal }), tracker)
      } finally { await hooks.dispose() }
    } else if (mode === "gateway") {
      const key = JSON.parse(fs.readFileSync(path.join(homeConfig, "caller-keys.json"), "utf8")).secret
      await readStream(await fetch("http://127.0.0.1:3425/v1/messages", { method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "anthropic-version": "2023-06-01" },
        body: JSON.stringify(body), signal }), tracker)
    } else throw new Error("Modes: acp plugin gateway")
  } catch (error) {
    console.log(JSON.stringify({ mode, error: String(error?.message ?? error).replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, "[token]").slice(0, 300) }))
    process.exitCode = 1
  } finally {
    tracker.summary()
    active = null
  }
}
try { for (const mode of modes.length ? modes : ["acp", "plugin", "gateway"]) await run(mode) }
finally { CodeBuddySession.prototype.push = originalPush }
