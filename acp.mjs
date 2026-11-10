// The Agent Client Protocol side of the CodeBuddy CLI.
//
// One AcpConnection is one `codebuddy --acp --acp-transport stdio` process and
// the JSON-RPC conversation on its stdin/stdout. CodeBuddy's own agent loop runs
// inside that process: it talks to its backend, runs its built-in tools, and
// calls the client's tools through the MCP server it was handed in session/new.
// This file only speaks the protocol; what a turn means is bridge.mjs's business.

import { spawnCodebuddy } from "./platform.mjs"

const LINE_LIMIT = 64 * 1024 * 1024
const DEFAULT_START_TIMEOUT_MS = 60_000

// CodeBuddy reports an upstream failure as a completed prompt whose stopReason
// is "refusal" and whose _meta carries the real error as a JSON string.
const ERROR_MESSAGE_KEY = "codebuddy.ai/errorMessage"
const OUTCOME_KEY = "codebuddy.ai/outcome"
const USAGE_KEY = "codebuddy.ai/usage"

export class AcpProtocolError extends Error {
  constructor(message) {
    super(message)
    this.name = "AcpProtocolError"
  }
}

// A failure CodeBuddy reported inside a prompt result, carrying the HTTP status
// its backend answered with so the caller can pass it on to the client.
export class AcpTurnError extends Error {
  constructor(message, { status = 0, category = "" } = {}) {
    super(message)
    this.name = "AcpTurnError"
    this.status = status
    this.category = category
  }
}

export class AcpCancelledError extends Error {
  constructor(message = "CodeBuddy ACP request was cancelled") {
    super(message)
    this.name = "AcpCancelledError"
  }
}

// CodeBuddy's prompt results name the end of a turn with these.
const STOP_REASONS = new Set(["end_turn", "max_tokens", "max_turn_requests", "refusal", "cancelled"])

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value)
const text = (value) => (typeof value === "string" ? value : "")
const count = (value) => {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0
}

// The error CodeBuddy puts in a prompt result. Its value is JSON in a string;
// anything unparseable is kept as the message so the reason is never lost.
export function turnErrorOf(result) {
  const meta = isObject(result?._meta) ? result._meta : {}
  const raw = meta[ERROR_MESSAGE_KEY]
  if (raw === undefined || raw === null) return null
  let payload = raw
  if (typeof raw === "string") {
    try {
      payload = JSON.parse(raw)
    } catch {
      return new AcpTurnError(raw)
    }
  }
  if (!isObject(payload)) return new AcpTurnError(String(payload))
  const data = isObject(payload.data) ? payload.data : {}
  const status = count(data.statusCode) || count(payload.code) || count(payload.status) || 0
  const category = text(data.category) || text(payload.category)
  const message = text(payload.message) || text(payload.detail) || text(payload.error) || "CodeBuddy request failed"
  return new AcpTurnError(message, { status, category })
}

// The token counts one usage_update carries. CodeBuddy sends them per internal
// model call; a prompt that made several reports the last call's numbers, so
// the caller accumulates rather than overwrites.
export function usageOf(update) {
  const meta = isObject(update?._meta) ? update._meta : {}
  const usage = isObject(meta[USAGE_KEY]) ? meta[USAGE_KEY] : null
  if (!usage) return null
  const details = isObject(usage.completion_tokens_details) ? usage.completion_tokens_details : {}
  const cached = count(usage.prompt_tokens_details?.cached_tokens) || count(usage.cached_tokens)
  const input = count(usage.prompt_tokens)
  const output = count(usage.completion_tokens)
  const reasoning = count(details.reasoning_tokens)
  const cost = isObject(update?.cost) ? Number(update.cost.amount) : NaN
  return {
    input,
    output,
    reasoning,
    cacheRead: Math.min(input, cached),
    // CodeBuddy prices a call in credits; keep it for the usage hook only.
    credits: Number.isFinite(cost) ? cost : 0,
    contextUsed: count(update?.used),
    contextSize: count(update?.size),
  }
}

/**
 * One `codebuddy --acp` child process.
 *
 * Notifications from the agent (`session/update`) go to `onNotification`.
 * Requests from the agent (`session/request_permission`) go to `onRequest`,
 * whose promise result is written back as the response.
 */
export class AcpConnection {
  #child
  #handlers
  #nextId = 0
  #pending = new Map()
  #buffer = ""
  #closed = false
  #closedError = null

  constructor(child, handlers = {}) {
    this.#child = child
    this.#handlers = handlers
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk) => this.#onData(chunk))
    // stderr can carry the account's token and private backend URLs, so it is
    // drained and never attached to an error the client might see.
    child.stderr.resume()
    child.on("error", (error) => this.close(error))
    child.on("close", (code) => {
      this.close(
        new Error(
          code === 0
            ? "CodeBuddy ACP process exited"
            : `CodeBuddy ACP process exited with code ${code ?? "unknown"}`,
        ),
      )
    })
    child.stdin.on("error", () => {})
    child.stdout.on("error", () => {})
  }

  get closed() {
    return this.#closed
  }

  get closedError() {
    return this.#closedError
  }

  get pid() {
    return this.#child.pid
  }

  request(method, params, { timeoutMs = 0, timeoutMessage = "" } = {}) {
    if (this.#closed) return Promise.reject(this.#closedError ?? new Error("CodeBuddy ACP connection is closed"))
    const id = ++this.#nextId
    return new Promise((resolve, reject) => {
      const entry = { method, resolve, reject, timer: null }
      if (timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          this.#pending.delete(id)
          reject(new Error(timeoutMessage || `CodeBuddy ACP ${method} timed out after ${timeoutMs}ms`))
        }, timeoutMs)
        entry.timer.unref?.()
      }
      this.#pending.set(id, entry)
      this.#write({ jsonrpc: "2.0", id, method, params })
    })
  }

  notify(method, params) {
    if (!this.#closed) this.#write({ jsonrpc: "2.0", method, params })
  }

  close(error) {
    if (this.#closed) return
    this.#closed = true
    this.#closedError = error ?? null
    for (const entry of this.#pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(error ?? new Error("CodeBuddy ACP connection is closed"))
    }
    this.#pending.clear()
  }

  #write(message) {
    try {
      if (this.#child.stdin?.writable) this.#child.stdin.write(JSON.stringify(message) + "\n")
    } catch {
      // A dead pipe surfaces through the child's close event.
    }
  }

  #onData(chunk) {
    this.#buffer += chunk
    if (this.#buffer.length > LINE_LIMIT) {
      this.#buffer = ""
      this.close(new AcpProtocolError("CodeBuddy ACP message exceeded 64 MiB"))
      return
    }
    for (;;) {
      const newline = this.#buffer.indexOf("\n")
      if (newline < 0) return
      const line = this.#buffer.slice(0, newline).trim()
      this.#buffer = this.#buffer.slice(newline + 1)
      if (!line) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        // A stray line on stdout is not a protocol frame; keep reading rather
        // than failing a turn that is otherwise healthy.
        continue
      }
      this.#dispatch(message)
    }
  }

  #dispatch(message) {
    if (!isObject(message)) return
    const hasId = Object.hasOwn(message, "id")
    const hasMethod = Object.hasOwn(message, "method")
    if (hasId && !hasMethod) {
      const entry = this.#pending.get(message.id)
      if (!entry) return
      this.#pending.delete(message.id)
      clearTimeout(entry.timer)
      if (message.error) {
        const error = new Error(
          `CodeBuddy ACP ${entry.method} failed: ${text(message.error?.message) || JSON.stringify(message.error)}`,
        )
        error.acpError = message.error
        entry.reject(error)
      } else {
        entry.resolve(message.result ?? null)
      }
      return
    }
    if (!hasMethod) return
    if (!hasId) {
      this.#handlers.onNotification?.(text(message.method), isObject(message.params) ? message.params : {})
      return
    }
    // A request from the agent: its answer must be written back.
    Promise.resolve()
      .then(() => this.#handlers.onRequest?.(text(message.method), isObject(message.params) ? message.params : {}))
      .then(
        (result) => this.#write({ jsonrpc: "2.0", id: message.id, result: result ?? null }),
        (error) =>
          this.#write({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: error?.code ?? -32603, message: String(error?.message ?? error) },
          }),
      )
  }
}

/**
 * A CodeBuddy ACP session: the process, its ACP connection, and one
 * `session/new` result (session id, offered models, permission modes).
 *
 * The process serves one conversation. Turns run one at a time; a turn that
 * ends in a tool call keeps its prompt request open until the client's result
 * is handed back, which is what lets the model see a native tool result.
 */
export class CodeBuddySession {
  constructor({ child, cwd, models, modes, sessionId, configOptions }) {
    this.cwd = cwd
    this.sessionId = sessionId
    this.models = models
    this.modes = modes
    this.configOptions = configOptions
    this.currentModelId = text(models?.currentModelId)
    this.lastUsedAt = Date.now()
    this.events = []
    this.waiters = new Set()
    this.usage = { input: 0, output: 0, reasoning: 0, cacheRead: 0, credits: 0, contextUsed: 0, contextSize: 0 }
    this.dead = false
    this.killed = false
    this.cancelling = false

    this.connection = new AcpConnection(child, {
      onNotification: (method, params) => this.#onNotification(method, params),
      onRequest: (method, params) => this.#onRequest(method, params),
    })
    this.child = child
  }

  get alive() {
    return !this.dead && !this.killed && !this.connection.closed
  }

  // A turn's stream pulls from this queue; a waiter resolves when something
  // arrives. Each waiter is woken individually and re-checks the queue itself:
  // waking them all at once would hand the same event to whoever ran first and
  // leave the others waiting until their timeout, which a stream reports as
  // "no output for too long".
  push(event) {
    this.events.push(event)
    for (const wake of [...this.waiters]) wake()
    this.waiters.clear()
  }

  // Resolves with the next event, or null when `timeoutMs` passes first.
  async next(timeoutMs = 0, signal) {
    if (this.events.length) return this.events.shift()
    if (signal?.aborted) throw new AcpCancelledError()
    await new Promise((resolve) => {
      let timer = null
      const done = () => {
        if (timer) clearTimeout(timer)
        this.waiters.delete(done)
        signal?.removeEventListener("abort", done)
        resolve()
      }
      this.waiters.add(done)
      if (timeoutMs > 0) {
        timer = setTimeout(done, timeoutMs)
        timer.unref?.()
      }
      signal?.addEventListener("abort", done, { once: true })
    })
    return this.events.length ? this.events.shift() : null
  }

  /**
   * Wait for the queue to hold something, without taking it.
   *
   * Used to learn whether a turn failed before any of it was sent, so the HTTP
   * status can still be chosen. Returns the first event (still queued) or null.
   */
  async peekNext(timeoutMs = 0, signal) {
    if (!this.events.length) {
      if (signal?.aborted) throw new AcpCancelledError()
      await new Promise((resolve) => {
        let timer = null
        const done = () => {
          if (timer) clearTimeout(timer)
          this.waiters.delete(done)
          signal?.removeEventListener("abort", done)
          resolve()
        }
        this.waiters.add(done)
        if (timeoutMs > 0) {
          timer = setTimeout(done, timeoutMs)
          timer.unref?.()
        }
        signal?.addEventListener("abort", done, { once: true })
      })
    }
    return this.events[0] ?? null
  }

  #onNotification(method, params) {
    if (method !== "session/update") return
    const update = isObject(params.update) ? params.update : null
    if (!update) return
    const kind = text(update.sessionUpdate)
    // The metadata notification that precedes the session/new response names a
    // session id we do not know yet; it carries nothing a turn needs.
    if (kind === "config_option_update" || kind === "available_commands_update") return
    if (kind === "session_info_update") return
    if (kind === "usage_update") {
      const usage = usageOf(update)
      if (!usage) return
      // These are per internal model call, so accumulate the token counts.
      this.usage.input += usage.input
      this.usage.output += usage.output
      this.usage.reasoning += usage.reasoning
      this.usage.cacheRead += usage.cacheRead
      this.usage.credits += usage.credits
      if (usage.contextUsed) this.usage.contextUsed = usage.contextUsed
      if (usage.contextSize) this.usage.contextSize = usage.contextSize
      this.push({ type: "usage", usage })
      return
    }
    if (kind === "agent_message_chunk" || kind === "agent_thought_chunk") {
      const content = isObject(update.content) ? update.content : null
      if (content?.type !== "text") return
      const delta = text(content.text)
      if (!delta) return
      this.push({ type: kind === "agent_message_chunk" ? "text" : "thinking", text: delta })
      return
    }
    if (kind === "tool_call" || kind === "tool_call_update") {
      // CodeBuddy's own built-in tools (Bash, Edit, Read, ...) report progress
      // this way. The client never executes these: the CLI does. They are
      // forwarded so a client can show what is happening, nothing more.
      const id = text(update.toolCallId)
      if (!id) return
      const status = text(update.status)
      const name = text(update.title) || text(update.kind) || "CodeBuddy tool"
      this.push({
        type: "builtin-tool",
        id,
        name,
        status,
        input: Object.hasOwn(update, "rawInput") ? update.rawInput : undefined,
        output: Object.hasOwn(update, "rawOutput") ? update.rawOutput : undefined,
      })
      return
    }
  }

  // CodeBuddy asks before running one of its own tools. The client executes
  // tools here, so a request that reaches us is one the bridge did not expect:
  // answer it the way the session was configured, never by inventing an option.
  async #onRequest(method, params) {
    if (method !== "session/request_permission") {
      throw Object.assign(new Error(`Unsupported CodeBuddy ACP request: ${method}`), { code: -32601 })
    }
    const decide = this.permissionDecider
    if (typeof decide !== "function") return { outcome: { outcome: "cancelled" } }
    const options = Array.isArray(params.options) ? params.options.filter(isObject) : []
    const optionId = decide({ options, toolCall: isObject(params.toolCall) ? params.toolCall : {} })
    if (!optionId) return { outcome: { outcome: "cancelled" } }
    // Remember that this turn had a tool refused. CodeBuddy ends such a prompt as
    // "cancelled", which must not be read as the client cancelling the request.
    const chosen = options.find((option) => option.optionId === optionId)
    if (chosen && (chosen.kind === "reject_once" || chosen.kind === "reject")) {
      this.refusedTool = true
    }
    return { outcome: { outcome: "selected", optionId } }
  }

  setPermissionDecider(decider) {
    this.permissionDecider = decider
  }

  async setModel(modelId) {
    if (!modelId || modelId === this.currentModelId) return this.currentModelId
    const result = await this.connection.request("session/set_model", { sessionId: this.sessionId, modelId })
    const confirmed = text(result?.modelId) || modelId
    if (confirmed !== modelId) throw new Error(`CodeBuddy did not confirm the model switch to ${modelId}`)
    this.currentModelId = confirmed
    return confirmed
  }

  cancel() {
    if (this.cancelling || !this.alive) return
    this.cancelling = true
    try {
      this.connection.notify("session/cancel", { sessionId: this.sessionId })
    } catch {
      // A broken pipe is handled by stop().
    }
    // A cancelled turn leaves the process usable but its prompt resolved with
    // "cancelled": the next turn must be able to cancel again, and the flag must
    // not make this session look permanently cancelled.
    setTimeout(() => {
      this.cancelling = false
    }, 1000).unref?.()
  }

  async stop() {
    if (this.killed) return
    this.killed = true
    this.dead = true
    const child = this.child
    // A fully reaped child's old group id may have been reused. Still reap a
    // running child or descendants whose inherited pipes keep the connection open.
    const shouldKill = !this.connection.closed || (child.exitCode === null && child.signalCode === null)
    this.connection.close(new Error("CodeBuddy ACP session stopped"))
    try {
      child.stdin?.destroy()
    } catch {}
    const pid = child.pid
    // Never turn a missing/invalid PID into a process-group broadcast, or target
    // this process (or init) if a malformed child object reaches this boundary.
    if (shouldKill && Number.isInteger(pid) && pid > 1 && pid !== process.pid) {
      try {
        if (process.platform !== "win32") {
          // spawnCodebuddy gives the CLI its own process group on POSIX. Reap its
          // tools too, including descendants still holding the stdio pipes open.
          process.kill(-pid, "SIGKILL")
        } else {
          child.kill("SIGKILL")
        }
      } catch {
        try {
          child.kill("SIGKILL")
        } catch {}
      }
    }
    await new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve()
      const finish = () => {
        clearTimeout(timer)
        child.removeListener("close", finish)
        resolve()
      }
      const timer = setTimeout(finish, 2000)
      timer.unref?.()
      child.once("close", finish)
    })
  }
}

/**
 * Start a codebuddy ACP process and open one session on it.
 *
 * `mcpServers` is how the client's tools reach the model: CodeBuddy connects to
 * each HTTP MCP server and calls its tools itself.
 */
export async function openCodeBuddySession({
  launch,
  argv,
  cwd,
  env,
  mcpServers = [],
  clientInfo = { name: "magpie-codebuddy-cli", version: "0.0.0" },
  startTimeoutMs = DEFAULT_START_TIMEOUT_MS,
  signal,
}) {
  const child = spawnCodebuddy(launch, argv, { cwd, env })

  // Build the session object before the handshake so the metadata notification
  // that arrives before session/new has somewhere to go.
  const session = new CodeBuddySession({
    child,
    cwd,
    sessionId: "",
    models: null,
    modes: null,
    configOptions: null,
  })

  try {
    await new Promise((resolve, reject) => {
      const finish = (error) => {
        clearTimeout(timer)
        child.removeListener("error", onError)
        child.removeListener("spawn", onSpawn)
        if (error) reject(error)
        else resolve()
      }
      const onError = (error) => finish(error)
      const onSpawn = () => finish()
      const timer = setTimeout(
        () => finish(new Error(`CodeBuddy ACP process did not start within ${startTimeoutMs}ms`)),
        startTimeoutMs,
      )
      timer.unref?.()
      child.once("error", onError)
      child.once("spawn", onSpawn)
    })
    const init = await session.connection.request(
      "initialize",
      { protocolVersion: 1, clientCapabilities: {}, clientInfo },
      { timeoutMs: startTimeoutMs, timeoutMessage: "CodeBuddy ACP initialize timed out" },
    )
    if (!isObject(init)) throw new AcpProtocolError("CodeBuddy ACP initialize returned no capabilities")
    if (Number(init.protocolVersion) !== 1) {
      throw new AcpProtocolError(`CodeBuddy ACP speaks protocol ${init.protocolVersion}, this plugin needs 1`)
    }
    session.agentCapabilities = isObject(init.agentCapabilities) ? init.agentCapabilities : {}
    session.authMethods = Array.isArray(init.authMethods) ? init.authMethods : []

    const opened = await session.connection.request(
      "session/new",
      { cwd, mcpServers },
      { timeoutMs: startTimeoutMs, timeoutMessage: "CodeBuddy ACP session/new timed out" },
    )
    if (!isObject(opened) || !text(opened.sessionId)) {
      throw new AcpProtocolError("CodeBuddy ACP session/new returned no session id")
    }
    session.sessionId = text(opened.sessionId)
    session.models = isObject(opened.models) ? opened.models : null
    session.modes = isObject(opened.modes) ? opened.modes : null
    session.configOptions = Array.isArray(opened.configOptions) ? opened.configOptions : null
    session.currentModelId = text(session.models?.currentModelId)
    session.usage = { input: 0, output: 0, reasoning: 0, cacheRead: 0, credits: 0, contextUsed: 0, contextSize: 0 }
    return session
  } catch (error) {
    await session.stop()
    throw error
  }
}

/**
 * Run one prompt to completion, pushing its events onto the session queue.
 *
 * Returns the prompt result. Throws AcpCancelledError when the turn was
 * cancelled, and AcpTurnError when CodeBuddy reported a failure inside an
 * otherwise normal result.
 */
export async function promptSession(session, parts, { signal, onResult } = {}) {
  if (signal?.aborted) throw new AcpCancelledError()
  const onAbort = () => session.cancel()
  signal?.addEventListener("abort", onAbort, { once: true })
  session.cancelling = false
  session.refusedTool = false
  try {
    const result = await session.connection.request("session/prompt", {
      sessionId: session.sessionId,
      prompt: parts,
    })
    if (!isObject(result)) throw new AcpProtocolError("CodeBuddy ACP prompt returned no result")
    const stopReason = text(result.stopReason)
    if (stopReason && !STOP_REASONS.has(stopReason)) {
      throw new AcpProtocolError(`CodeBuddy ACP prompt stopped with an unknown reason: ${stopReason}`)
    }
    onResult?.(result)
    const meta = isObject(result._meta) ? result._meta : {}
    const outcome = text(meta[OUTCOME_KEY])
    const error = turnErrorOf(result)
    // CodeBuddy ends a prompt as "cancelled" when one of its own tools is refused.
    // That is this bridge declining to run work in CodeBuddy's workspace — not the
    // client walking away — so the turn is treated as finished: whatever the model
    // already produced still reaches the client, and the next turn starts clean.
    const refusedTool = session.refusedTool === true
    if (refusedTool) session.refusedTool = false
    const cancelled = stopReason === "cancelled" || outcome === "CANCELLED"
    if (cancelled && !refusedTool) throw new AcpCancelledError()
    if (cancelled) return { result, stopReason: "end_turn", outcome: "SUCCESS", partial: false }
    if (error) throw error
    if (outcome && outcome !== "SUCCESS" && outcome !== "PARTIAL_SUCCESS") {
      throw new AcpTurnError(`CodeBuddy finished with outcome ${outcome}`)
    }
    if (stopReason === "refusal") throw new AcpTurnError("CodeBuddy refused the request")
    if (stopReason !== "end_turn" && stopReason !== "max_tokens" && stopReason !== "max_turn_requests") {
      throw new AcpTurnError(`CodeBuddy stopped without finishing (${stopReason || "no stop reason"})`)
    }
    return { result, stopReason, outcome, partial: outcome === "PARTIAL_SUCCESS" }
  } catch (error) {
    if (signal?.aborted && !(error instanceof AcpTurnError)) throw new AcpCancelledError()
    throw error
  } finally {
    signal?.removeEventListener("abort", onAbort)
  }
}

export { DEFAULT_START_TIMEOUT_MS }
