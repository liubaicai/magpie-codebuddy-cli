// Magpie / OpenCode provider for the local Tencent CodeBuddy CLI.
//
// The plugin is an Anthropic Messages endpoint whose work is done by a real
// `codebuddy --acp` process. A request's messages become one ACP prompt, the
// CLI's stream becomes Anthropic SSE, and the client's tools reach the model
// through an MCP server this plugin runs for each process.
//
// Tool calls are the part that needs care. In Anthropic Messages a tool is
// executed by the client and its result arrives in the *next* request. Here the
// model asks for one through MCP, which is a synchronous call. So the bridge
// holds that MCP call open, ends the HTTP response with stop_reason "tool_use",
// and when the client posts the matching tool_result it resolves the held call —
// the CLI then continues the same turn with a native tool result, and the rest
// of the answer streams out of that same turn.

import { createHash, randomBytes } from "node:crypto"
import fs from "node:fs"

import {
  AcpCancelledError,
  AcpTurnError,
  openCodeBuddySession,
  promptSession,
} from "./acp.mjs"
import {
  codebuddyLaunchArgs,
  codebuddyVersion,
  findCodebuddy,
} from "./platform.mjs"
import { CodeBuddySignIn, POLL_INTERVAL_S, SignInError, tokenIdentity, validToken } from "./accounts.mjs"
import { SessionPool } from "./session-pool.mjs"
import { creditUsage } from "./credits.mjs"
import {
  UnsupportedContent,
  STREAM_THINKING_LEAD,
  canonicalBody,
  conversationKey,
  estimateInputTokens,
  normalizeTools,
  historyExtends,
  renderHistory,
  splitRequest,
  systemText,
  thinkingSignature,
  turnParts,
  usageBlock,
  validateBody,
} from "./translate.mjs"

const PROVIDER_ID = "codebuddy-cli"
const NPM_ANTHROPIC = "@ai-sdk/anthropic"

// The base URL the plugin pretends to serve. No request ever leaves the machine
// through it: the loader's fetch answers everything.
const VIRTUAL_BASE = "codebuddy-cli://local"

const DEFAULT_MODEL_CATALOG_TTL_MS = 5 * 60 * 1000
const CATALOG_WAIT_MS = 1200
const CATALOG_PROBE_TIMEOUT_MS = 45_000
const START_TIMEOUT_MS = 90_000
const TURN_IDLE_TIMEOUT_MS = 10 * 60 * 1000
const TOOL_RESULT_TIMEOUT_MS = 30 * 60 * 1000
// CodeBuddy's own MCP client gives up on a call after about three minutes.
// Answer before that and keep the real result for a later turn.
const TOOL_DEADLINE_MS = 150_000
const PING_INTERVAL_MS = 15_000

// Models served before the CLI has been asked. CodeBuddy decides the real list;
// these only keep the picker populated while the first probe runs.
const FALLBACK_MODELS = [
  { id: "hy3", name: "Hy3", context: 192000, reasoning: true, images: true },
  { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", context: 1000000, reasoning: true, images: true },
  { id: "glm-5.3", name: "GLM 5.3", context: 1000000, reasoning: true, images: true },
]

const log = (...args) => {
  try {
    console.log(`[${PROVIDER_ID}]`, ...args)
  } catch {}
}

const positive = (value, fallback) => {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : fallback
}

const envNumber = (name, fallback) => positive(process.env[name], fallback)

// ---- the CLI on this machine ---------------------------------------------

let cachedLaunch
let cachedLaunchAt = 0
const LAUNCH_TTL_MS = 60_000

// `CODEBUDDY_PATH` / `CODEBUDDY_BIN` name the CLI explicitly, so a cached answer
// is only reused while that name stays the same. A test (or a user) pointing the
// plugin at another binary must take effect at once.
const launchKey = () => `${process.env.CODEBUDDY_PATH ?? ""}\u0000${process.env.CODEBUDDY_BIN ?? ""}`

async function launchOf() {
  const now = Date.now()
  const key = launchKey()
  if (cachedLaunch && cachedLaunchAt.key === key && now - cachedLaunchAt.at < LAUNCH_TTL_MS) {
    return cachedLaunch
  }
  cachedLaunch = await findCodebuddy()
  cachedLaunchAt = { at: now, key }
  return cachedLaunch
}

// The child's environment: the host's, minus the variables that would make the
// CLI treat this bridge as a job of some other session, plus the account token
// when the plugin is configured with one.
//
// The token is read at call time, not once at load, so a long-lived Magpie (its
// plugin host outlives any single request) picks up a renewed token without a
// restart. A file is supported because an environment variable only reaches a
// process started after it was set, which is not how a running desktop app
// behaves.
function readToken() {
  const inline = process.env.CODEBUDDY_AUTH_TOKEN
  if (typeof inline === "string" && inline.trim()) return inline.trim()
  const file = process.env.CODEBUDDY_AUTH_TOKEN_FILE
  if (typeof file === "string" && file.trim()) {
    try {
      const raw = fs.readFileSync(file.trim(), "utf8").trim()
      if (!raw) return undefined
      // Accept either the bare token or a JSON file with one in it, so a
      // credentials file can be pointed at directly.
      if (raw.startsWith("{")) {
        const parsed = JSON.parse(raw)
        const candidate =
          parsed?.accessToken ??
          parsed?.access_token ??
          parsed?.auth?.accessToken ??
          parsed?.auth?.access_token ??
          parsed?.credential?.accessToken
        return typeof candidate === "string" && candidate ? candidate : undefined
      }
      return raw
    } catch {
      return undefined
    }
  }
  return undefined
}

function childEnv(authToken = readToken()) {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === "CODEBUDDY_JOB_ID") delete env[key]
  }
  // A token inherited from whatever started Magpie must never be used for the
  // CLI's calls unless the plugin was explicitly given one.
  delete env.CODEBUDDY_AUTH_TOKEN
  if (authToken) env.CODEBUDDY_AUTH_TOKEN = authToken
  // Several ACP processes share one installation; the CLI's own updater must not
  // race between them.
  if (env.CODEBUDDY_CLI_DISABLE_AUTO_UPDATE === undefined) env.CODEBUDDY_CLI_DISABLE_AUTO_UPDATE = "true"
  return env
}

// ---- the model catalog ----------------------------------------------------

let catalog = null
let catalogAt = 0
let catalogPromise = null
let catalogError = null

function fallbackCatalog() {
  return FALLBACK_MODELS.map((model) => ({ ...model }))
}

function catalogFresh() {
  return catalog !== null && Date.now() - catalogAt < envNumber("CODEBUDDY_BRIDGE_CATALOG_TTL_MS", DEFAULT_MODEL_CATALOG_TTL_MS)
}

// The models CodeBuddy offers this client. ACP reports them in session/new,
// with the account's own limits and capabilities.
export function modelsFromSession(session) {
  const available = session?.models?.availableModels
  if (!Array.isArray(available)) return []
  const out = []
  const seen = new Set()
  for (const entry of available) {
    if (!entry || typeof entry.modelId !== "string" || !entry.modelId) continue
    if (seen.has(entry.modelId)) continue
    seen.add(entry.modelId)
    const meta = entry._meta && typeof entry._meta === "object" ? entry._meta : {}
    const efforts = Array.isArray(meta.effortOptions)
      ? meta.effortOptions.map((option) => option?.value).filter((value) => typeof value === "string" && value)
      : []
    out.push({
      id: entry.modelId,
      name: typeof entry.name === "string" && entry.name ? entry.name : entry.modelId,
      context: positive(meta.maxInputTokens, 0) || undefined,
      ...(positive(meta.maxOutputTokens, 0) ? { output: positive(meta.maxOutputTokens, 0) } : {}),
      reasoning: meta.supportsReasoning === true || efforts.length > 0,
      images: meta.supportsImages === true,
      efforts,
      credits: typeof meta.credits === "string" ? meta.credits : undefined,
    })
  }
  return out
}

/**
 * Ask the CLI which models it offers by opening a session and closing it again.
 *
 * Magpie waits about two seconds for models(), so this runs in the background:
 * the first call returns the fallback list and later ones the real catalog.
 */
function refreshCatalog() {
  if (catalogPromise) return catalogPromise
  catalogPromise = (async () => {
    let session = null
    try {
      const launch = await launchOf()
      if (!launch) {
        catalogError = "the codebuddy CLI was not found; set CODEBUDDY_PATH"
        return null
      }
      session = await openCodeBuddySession({
        launch,
        argv: codebuddyLaunchArgs({ sessionPersistence: false }),
        cwd: process.cwd(),
        env: childEnv(),
        startTimeoutMs: envNumber("CODEBUDDY_BRIDGE_START_TIMEOUT_MS", CATALOG_PROBE_TIMEOUT_MS),
      })
      const models = modelsFromSession(session)
      if (models.length) {
        catalog = models
        catalogAt = Date.now()
        catalogError = null
        log(`catalog: ${models.length} models from codebuddy ${await codebuddyVersion(launch).catch(() => null) ?? ""}`.trim())
      }
      return models.length ? models : null
    } catch (error) {
      catalogError = String(error?.message ?? error)
      log(`catalog probe failed: ${catalogError}`)
      return null
    } finally {
      await session?.stop().catch(() => {})
      catalogPromise = null
    }
  })()
  return catalogPromise
}

async function currentCatalog({ wait = false } = {}) {
  if (catalogFresh()) return catalog
  const promise = refreshCatalog()
  if (wait) {
    const models = await promise
    if (models?.length) return models
  } else {
    // Give a warm probe a short head start, then answer with what we have.
    let timer
    try {
      await Promise.race([promise, new Promise((resolve) => {
        timer = setTimeout(resolve, CATALOG_WAIT_MS)
        timer.unref?.()
      })])
    } finally {
      clearTimeout(timer)
    }
  }
  return catalog ?? fallbackCatalog()
}

// Per-account catalogs. Magpie asks each account for its own list, and the
// accounts differ: a plan's models are the account's, not the plugin's.
const accountCatalogs = new Map()
const ACCOUNT_CATALOG_LIMIT = 32

async function catalogFor(token) {
  const key = accountKeyOf(token)
  const cached = accountCatalogs.get(key)
  if (cached && Date.now() - cached.at < envNumber("CODEBUDDY_BRIDGE_CATALOG_TTL_MS", DEFAULT_MODEL_CATALOG_TTL_MS)) {
    return cached.models
  }
  const launch = await launchOf()
  if (!launch) return fallbackCatalog()
  let session = null
  try {
    session = await openCodeBuddySession({
      launch,
      argv: codebuddyLaunchArgs({ sessionPersistence: false }),
      cwd: process.cwd(),
      env: childEnv(token),
      startTimeoutMs: envNumber("CODEBUDDY_BRIDGE_START_TIMEOUT_MS", CATALOG_PROBE_TIMEOUT_MS),
    })
    const models = modelsFromSession(session)
    if (!models.length) return fallbackCatalog()
    accountCatalogs.set(key, { at: Date.now(), models })
    while (accountCatalogs.size > ACCOUNT_CATALOG_LIMIT) {
      accountCatalogs.delete(accountCatalogs.keys().next().value)
    }
    return models
  } catch (error) {
    catalogError = String(error?.message ?? error)
    log(`catalog probe failed for an account: ${catalogError}`)
    return fallbackCatalog()
  } finally {
    await session?.stop().catch(() => {})
  }
}

/** The catalog entry for a requested model id, matching loosely. */
export function resolveModel(models, requested) {
  const name = String(requested ?? "").trim()
  if (!name) return models[0] ?? null
  const bare = name.includes("/") ? name.split("/").pop() : name
  const lower = bare.toLowerCase()
  return (
    models.find((model) => model.id === bare) ??
    models.find((model) => model.id.toLowerCase() === lower) ??
    models.find((model) => model.name.toLowerCase() === lower) ??
    models.find((model) => model.id.toLowerCase().startsWith(lower)) ??
    null
  )
}

// ---- permission policy ---------------------------------------------------

// CodeBuddy reaches a client tool through its own `DeferExecuteTool`, naming the
// tool as `mcp__<server>__<tool>`. That grant is what lets the bridge work at
// all, so it is always allowed — for this bridge's own server only.
const BRIDGE_MCP_PREFIX = "mcp__client-tools__"

function toolNameOf(request) {
  const toolCall = request?.toolCall && typeof request.toolCall === "object" ? request.toolCall : {}
  const raw = toolCall.rawInput && typeof toolCall.rawInput === "object" ? toolCall.rawInput : {}
  const name = typeof raw.toolName === "string" ? raw.toolName : ""
  return name
}

/**
 * Answer one of CodeBuddy's permission requests.
 *
 * Two kinds arrive. A request for `DeferExecuteTool` naming a tool of this
 * bridge's MCP server is the client's own tool, and allowing it is the point of
 * the plugin. Other requests run in the plugin host's working directory and
 * follow the caller's allowNative policy (enabled by default by handleMessages).
 */
export function decidePermission({ options, toolCall }, { allowNative = false } = {}) {
  const list = Array.isArray(options) ? options : []
  // Prefer a one-shot grant; a permanent one would outlive this bridge.
  const allowOnce = list.find((option) => option?.kind === "allow_once") ?? list.find((option) => option?.kind === "allow")
  const reject = list.find((option) => option?.kind === "reject_once") ?? list.find((option) => option?.kind === "reject")

  const name = toolNameOf({ toolCall })
  const bridged = name.startsWith(BRIDGE_MCP_PREFIX)
  // A client tool is what this bridge exists for.
  if (bridged) return allowOnce?.optionId ?? null
  // Native tools follow the policy captured in this process's reuse signature.
  if (allowNative) return allowOnce?.optionId ?? null
  return reject?.optionId ?? null
}

// The token a request runs under is the account. A hash keeps it out of logs and
// out of the pool's keys, while still telling two accounts apart.
function accountKeyOf(token) {
  const raw = typeof token === "string" ? token : ""
  return raw ? createHash("sha256").update(raw).digest("hex").slice(0, 16) : "cli"
}

/** A token as the account it belongs to: who, and when it stops working. */
export function accountOf(token) {
  const identity = tokenIdentity(token)
  return {
    key: accountKeyOf(token),
    ...(identity.uid ? { uid: identity.uid } : {}),
    ...(identity.name ? { name: identity.name } : {}),
    ...(identity.email ? { email: identity.email } : {}),
    ...(identity.expires ? { expires: identity.expires } : {}),
  }
}

// ---- reasoning effort ----------------------------------------------------

const EFFORT_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"]

/**
 * The reasoning effort this request asks for.
 *
 * A picker selection reaches a provider as `reasoning_effort` (what an AI SDK
 * model variant sends) or `effort`; a client may also state it in the Anthropic
 * `thinking` budget, which is a token count rather than a level. CodeBuddy takes
 * a level, so the first two are used as they are and the budget is mapped.
 */
export function requestedEffort(body) {
  const direct = [body?.output_config?.effort, body?.reasoning_effort, body?.reasoning?.effort, body?.effort, body?.reasoningEffort]
    .map((value) => String(value ?? "").trim().toLowerCase())
    .find((value) => EFFORT_LEVELS.includes(value))
  if (direct) return direct

  const budget = Number(body?.thinking?.budget_tokens)
  if (body?.thinking?.type === "enabled" && Number.isFinite(budget) && budget > 0) {
    // Match Magpie's Anthropic budget conversion so the gateway and CLI agree.
    if (budget <= 4096) return "low"
    if (budget <= 12000) return "medium"
    if (budget <= 24000) return "high"
    return "xhigh"
  }
  return ""
}

// ---- the bridge ----------------------------------------------------------

// One held tool call: the MCP request CodeBuddy is waiting on, or the result it
// asked for after the call was answered with a "still running" placeholder.
//
// Keyed by the call id a client sends back. A call is removed once it has been
// settled and its result has been handed to the model, so a later request cannot
// match a call that belongs to an older turn.
const heldCalls = new Map()
const HELD_LIMIT = 256

function rememberHeld(call) {
  heldCalls.set(call.id, call)
  while (heldCalls.size > HELD_LIMIT) heldCalls.delete(heldCalls.keys().next().value)
}

function toolCallId() {
  return "toolu_" + randomBytes(12).toString("hex")
}

class Bridge {
  constructor() {
    this.pool = new SessionPool({
      // A tool bridge is created per process before its session exists, so the
      // callback is handed the session the call came from once it is known.
      onToolCall: (name, args, meta) => this.#onToolCall(name, args, meta),
    })
    this.sweeper = setInterval(() => {
      this.pool.sweep().catch(() => {})
      this.#sweepHeld()
    }, 60_000)
    this.sweeper.unref?.()
  }

  // A tool the model asked for. The turn that is streaming this call is waiting
  // for the client's result, so the MCP request stays open until it arrives.
  // `owner` is the session whose process made the call, set by createToolBridge.
  async #onToolCall(name, args, meta, owner) {
    const turn = owner?.turn
    if (!turn || turn.finished) throw new Error("no active CodeBuddy turn to run a tool for")
    const id = toolCallId()
    const call = {
      id,
      name,
      args,
      turn,
      session: owner,
      convKey: turn.convKey,
      createdAt: Date.now(),
      clientSeen: false,
      answered: false,
      settled: false,
      resolve: null,
      reject: null,
      deadline: null,
    }
    const promise = new Promise((resolve, reject) => {
      call.resolve = resolve
      call.reject = reject
    })
    rememberHeld(call)
    turn.pending.set(id, call)
    // Hand the call to the streaming response, which turns it into a tool_use.
    owner.push({ type: "tool-call", call })
    // CodeBuddy's MCP client will not wait forever; answer before it gives up and
    // keep the real result for the follow-up prompt.
    call.deadline = setTimeout(() => {
      if (call.settled) return
      call.settled = true
      call.answered = true
      call.resolve(stillRunningText(call))
    }, envNumber("CODEBUDDY_BRIDGE_TOOL_DEADLINE_MS", TOOL_DEADLINE_MS))
    call.deadline.unref?.()
    return promise
  }

  /**
   * The MCP bridge for one session. The session is attached afterwards, so the
   * bridge holds a box the factory fills in as soon as the process is open.
   */
  toolBridgeFor() {
    const owner = { session: null }
    const bridge = this.pool.createToolBridge((name, args, meta) =>
      this.#onToolCall(name, args, meta, owner.session),
    )
    return { bridge, attach: (session) => { owner.session = session } }
  }

  #sweepHeld() {
    const cutoff = Date.now() - envNumber("CODEBUDDY_BRIDGE_TOOL_TIMEOUT_MS", TOOL_RESULT_TIMEOUT_MS)
    for (const [id, call] of [...heldCalls]) {
      if (call.createdAt > cutoff && !call.settled) continue
      if (!call.settled) {
        call.settled = true
        call.answered = true
        try {
          call.resolve(stillRunningText(call))
        } catch {}
      }
      if (call.createdAt <= cutoff) {
        clearTimeout(call.deadline)
        heldCalls.delete(id)
      }
    }
  }

  async close() {
    clearInterval(this.sweeper)
    for (const call of heldCalls.values()) {
      clearTimeout(call.deadline)
      if (!call.settled) {
        call.settled = true
        try {
          call.reject(new Error("the CodeBuddy bridge is shutting down"))
        } catch {}
      }
    }
    heldCalls.clear()
    await this.pool.close()
  }
}

function stillRunningText(call) {
  return (
    `The tool ${call.name} is still running on the client. Its result will be sent in a follow-up message. ` +
    `Do not call it again; end this turn and wait for the result.`
  )
}

// ---- the response stream -------------------------------------------------

const STOP_REASON_MAP = {
  end_turn: "end_turn",
  max_tokens: "max_tokens",
  max_turn_requests: "end_turn",
  refusal: "end_turn",
}

function sseEvent(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

/**
 * One Anthropic streaming response for one turn.
 *
 * The stream ends when the turn produced a tool call (stop_reason tool_use) or
 * when the prompt finished. A tool call does not finish the turn: the same
 * session keeps its prompt request open, and the next HTTP request continues it.
 */
function anthropicStream(session, turn, body, msgId, signal) {
  turn.streaming = true
  const encoder = new TextEncoder()
  const content = []
  let blockIndex = 0
  let open = null
  let finished = false
  let pingTimer = null
  let abortHandler = null
  let emittedOutput = 0
  let emittedThinking = 0
  const model = body.model

  const usage = () =>
    usageBlock(
      session.usage,
      estimateInputTokens(body),
      { output: Math.max(emittedOutput, 1), thinking: emittedThinking },
    )

  return new ReadableStream({
    async start(controller) {
      const send = (event, data) => controller.enqueue(encoder.encode(sseEvent(event, data)))

      const closeBlock = () => {
        if (!open) return
        if (open.type === "text") {
          content.push({ type: "text", text: open.text })
        } else {
          const signature = thinkingSignature(session.sessionId, open.text)
          send("content_block_delta", {
            type: "content_block_delta",
            index: blockIndex,
            delta: { type: "signature_delta", signature },
          })
          content.push({ type: "thinking", thinking: open.text, signature })
        }
        send("content_block_stop", { type: "content_block_stop", index: blockIndex })
        blockIndex++
        open = null
      }

      const emitDelta = (type, value) => {
        if (!value) return
        if (open?.type !== type) {
          closeBlock()
          send("content_block_start", {
            type: "content_block_start",
            index: blockIndex,
            content_block:
              type === "text"
                ? { type: "text", text: "" }
                : { type: "thinking", thinking: "" },
          })
          open = { type, text: "" }
        }
        open.text += value
        if (type === "text") emittedOutput += value.length
        else emittedThinking += value.length
        send("content_block_delta", {
          type: "content_block_delta",
          index: blockIndex,
          delta:
            type === "text"
              ? { type: "text_delta", text: value }
              : { type: "thinking_delta", thinking: value },
        })
      }

      const emitToolUse = (call) => {
        closeBlock()
        send("content_block_start", {
          type: "content_block_start",
          index: blockIndex,
          content_block: { type: "tool_use", id: call.id, name: call.name, input: {} },
        })
        send("content_block_delta", {
          type: "content_block_delta",
          index: blockIndex,
          delta: { type: "input_json_delta", partial_json: JSON.stringify(call.args ?? {}) },
        })
        send("content_block_stop", { type: "content_block_stop", index: blockIndex })
        blockIndex++
        content.push({ type: "tool_use", id: call.id, name: call.name, input: call.args ?? {} })
      }

      const stop = (stopReason, final) => {
        closeBlock()
        send("message_delta", {
          type: "message_delta",
          delta: { stop_reason: stopReason, stop_sequence: null },
          usage: usage(),
        })
        send("message_stop", { type: "message_stop" })
        session.history = [...session.history, { role: "assistant", content }]
        if (final) turn.finished = true
        session.busy = false
        session.lastUsedAt = Date.now()
      }

      const detach = () => {
        finished = true
        turn.streaming = false
        if (pingTimer) clearInterval(pingTimer)
        pingTimer = null
        if (abortHandler) signal?.removeEventListener("abort", abortHandler)
        abortHandler = null
      }

      const abort = () => {
        if (finished) return
        detach()
        turn.finished = true
        session.busy = false
        session.cancel()
        void session.stop().catch(() => {})
        try {
          controller.error(signal?.reason ?? new Error("request aborted"))
        } catch {}
      }
      abortHandler = abort
      signal?.addEventListener("abort", abort, { once: true })
      if (signal?.aborted) return abort()

      try {
        send("message_start", {
          type: "message_start",
          message: {
            id: msgId,
            type: "message",
            role: "assistant",
            model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        })
        pingTimer = setInterval(() => {
          try {
            send("ping", { type: "ping" })
          } catch {}
        }, PING_INTERVAL_MS)

        for (;;) {
          if (finished) return
          const event = await session.next(envNumber("CODEBUDDY_BRIDGE_TURN_IDLE_MS", TURN_IDLE_TIMEOUT_MS), signal)
          if (finished) return
          if (!event) {
            // No output for the whole idle budget: the CLI is wedged.
            session.cancel()
            throw new Error("CodeBuddy produced no output for too long")
          }
          if (event.type === "text") {
            emitDelta("text", event.text)
            continue
          }
          if (event.type === "thinking") {
            // CodeBuddy's thought stream, which is what makes the wait visible.
            //
            // A gateway in front of this plugin drops thinking blocks unless the
            // *client's own* request asked for thinking (`thinking.type` present
            // and not "disabled"). When the client did not ask, sending thinking
            // would be discarded and the user would see nothing while the model
            // works — the silence this bridge is meant to remove. In that case the
            // thought text goes out as the answer instead.
            const thinkingType = body.thinking?.type
            if (thinkingType === "disabled") continue
            const askedForThinking = thinkingType === "enabled" || thinkingType === "adaptive"
            if (askedForThinking) {
              // Magpie holds untrusted reasoning until ordinary content begins.
              // Only after a real thought arrives, emit one whitespace text block
              // to release that hold. Empty text/pings do not release it. Keep
              // nonstream responses and already-started answers unchanged.
              if (event.text && !open && content.length === 0 && body.stream !== false &&
                  process.env.CODEBUDDY_BRIDGE_THINKING_LEAD !== "0") {
                emitDelta("text", STREAM_THINKING_LEAD)
                emittedOutput -= STREAM_THINKING_LEAD.length // not model output
              }
              emitDelta("thinking", event.text)
            } else emitDelta("text", event.text)
            continue
          }
          if (event.type === "usage") continue
          if (event.type === "builtin-tool") continue
          if (event.type === "tool-call") {
            const call = event.call
            if (call.clientSeen) continue
            call.clientSeen = true
            emitToolUse(call)
            // The response ends while the prompt waits for a tool result. The
            // unfinished turn keeps its process reserved until it is continued.
            stop("tool_use", false)
            detach()
            controller.close()
            return
          }
          if (event.type === "turn-end") {
            const stopReason = STOP_REASON_MAP[event.stopReason] ?? "end_turn"
            stop(stopReason, true)
            detach()
            controller.close()
            return
          }
          if (event.type === "turn-error") {
            closeBlock()
            send("error", {
              type: "error",
              error: { type: "api_error", message: String(event.error?.message ?? event.error) },
            })
            turn.finished = true
            session.busy = false
            void session.stop().catch(() => {})
            detach()
            controller.close()
            return
          }
        }
      } catch (error) {
        if (finished) return
        turn.finished = true
        session.busy = false
        session.cancel()
        void session.stop().catch(() => {})
        detach()
        try {
          closeBlock()
          send("error", {
            type: "error",
            error: { type: "api_error", message: String(error?.message ?? error) },
          })
          controller.close()
        } catch {
          try {
            controller.error(error)
          } catch {}
        }
      }
    },
    cancel() {
      if (finished) return
      abortHandler?.()
    },
  })
}

// ---- one turn ------------------------------------------------------------

/**
 * Start a turn on a session: send the prompt and let it stream into the queue.
 *
 * The prompt request is not awaited here; promptSession resolves in the
 * background and pushes turn-end or turn-error when it does.
 */
function startTurn(session, convKey, body, { history, turn: lastMessage }) {
  const turn = {
    convKey,
    session,
    pending: new Map(),
    finished: false,
    streaming: false,
  }
  // Whatever the previous turn left behind belongs to it, not this one: a
  // turn-end the old stream never read would otherwise end this turn at once,
  // and its text would be replayed as if it were the answer to this request.
  //
  // A turn that ended in a tool call is the exception: CodeBuddy is still holding
  // its prompt open, and the events it produces when the result arrives belong to
  // that turn, not to this one. Such a turn is never replaced while it is open.
  session.events.length = 0
  session.turn = turn
  session.busy = true
  // Usage is per turn: CodeBuddy reports each internal model call, and the
  // accumulated counts must not carry over from the previous turn.
  session.usage = { input: 0, output: 0, reasoning: 0, cacheRead: 0, credits: 0, contextUsed: 0, contextSize: 0 }

  // CodeBuddy keeps the conversation in its own session, so only the first turn
  // of a process carries the transcript. A later turn on the same process sends
  // just the new message.
  const parts = []
  const fresh = !session.seenInstructions
  if (fresh) {
    const rendered = renderHistory(history)
    if (rendered) {
      parts.push({
        type: "text",
        text: `The following is the conversation so far, for context. Continue it as the assistant.\n\n${rendered}\n\n---\n\n`,
      })
    }
    const instruction = systemText(canonicalBody(body))
    if (instruction) {
      parts.push({ type: "text", text: `Instructions from the client:\n\n${instruction}\n\n---\n\n` })
    }
    session.seenInstructions = true
  }
  parts.push(...turnParts(lastMessage))
  if (!parts.length) parts.push({ type: "text", text: "" })

  void promptSession(session, parts)
    .then(({ stopReason, partial }) => {
      if (turn.finished) return
      // Do not release the process until its stream has consumed this event and
      // committed the assistant reply. Otherwise a racer can clear unread data.
      session.push({ type: "turn-end", stopReason, partial })
    })
    .catch((error) => {
      if (turn.finished) return
      session.push({ type: "turn-error", error })
      // A failed prompt's context is uncertain, even for a vendor API error.
      void session.stop().catch(() => {})
    })
  return turn
}

/**
 * Continue a turn whose tool results just arrived: resolve the held MCP calls so
 * CodeBuddy carries on inside the same prompt, and stream what it produces next.
 */
function continueTurn(session, turn, results) {
  if (results.some(({ call }) => !call || call.session !== session || call.turn !== turn)) return false
  for (const { block, call } of results) {
    const value = toolResultValue(block)
    if (call && !call.settled) {
      call.settled = true
      call.delivered = true
      clearTimeout(call.deadline)
      call.resolve(value)
      continue
    }
    if (call) {
      // The call was already answered with a placeholder; deliver the real
      // result as a follow-up prompt so the model still sees it.
      call.delivered = true
      const text = `[the result of the tool call ${call.name} you asked for earlier]\n${value}\n[end of tool result]`
      void promptSession(session, [{ type: "text", text }]).catch((error) => {
        session.push({ type: "turn-error", error })
      })
      continue
    }
    // A result for a call this bridge does not know about: the client's history
    // and the live turn disagree, so start over rather than guess.
    session.push({
      type: "turn-error",
      error: new Error(
        "this tool result does not belong to the active CodeBuddy turn; resend the request with the last consistent history",
      ),
    })
    return false
  }
  return true
}

/** A tool_result block as the text the model sees. */
function toolResultValue(block) {
  const content = block?.content
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  const parts = []
  for (const part of content) {
    if (typeof part === "string") {
      parts.push(part)
      continue
    }
    if (part?.type === "text") {
      parts.push(String(part.text ?? ""))
      continue
    }
    if (part?.type === "image") parts.push("[an image was returned by the tool]")
  }
  const text = parts.join("\n")
  return block?.is_error ? `[the tool reported an error]\n${text}` : text
}

/** The tool_result blocks of a request whose last message is a tool round. */
function toolResultsOf(body) {
  const { turn } = splitRequest(canonicalBody(body))
  if (!turn || turn.role !== "user" || !Array.isArray(turn.content)) return []
  const results = []
  for (const block of turn.content) {
    if (block?.type !== "tool_result") continue
    const id = String(block.tool_use_id ?? "")
    // A result whose call this bridge already answered is not a live round: the
    // model has seen it, so the request is an ordinary turn, not a continuation.
    const call = heldCalls.get(id) ?? null
    if (call && call.delivered) {
      heldCalls.delete(id)
      continue
    }
    results.push({ block, call })
  }
  return results
}

// ---- the HTTP surface ----------------------------------------------------

function jsonError(status, message, code, extra) {
  return new Response(
    JSON.stringify({
      type: "error",
      error: {
        type: status === 400 ? "invalid_request_error" : "api_error",
        ...(code ? { code } : {}),
        message: String(message || "unknown error"),
        ...(extra ?? {}),
      },
    }),
    {
      status,
      headers: {
        "Content-Type": "application/json",
        // SDKs that honour this stop retrying a request that cannot succeed.
        ...(status === 400 || status === 409 ? { "x-should-retry": "false" } : {}),
      },
    },
  )
}

async function handleCountTokens(body) {
  return new Response(JSON.stringify({ input_tokens: estimateInputTokens(body) }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })
}

/**
 * Answer one Anthropic Messages request.
 *
 * Three shapes arrive here: a new turn (send a prompt), the continuation of a
 * turn whose tools just ran (resolve them, keep streaming), and a request whose
 * history no longer matches the live session (start a fresh one).
 */
async function handleMessages(body, signal, bridge, authToken) {
  validateBody(body)
  const canonical = canonicalBody(body)

  // The model list of the account this request runs under, so a route that
  // picked an account resolves the model against that account's own catalog.
  const models = authToken ? await catalogFor(authToken) : await currentCatalog()
  const requested = String(body.model ?? "")
  const model = resolveModel(models, requested)
  const modelId = model?.id ?? (requested.includes("/") ? requested.split("/").pop() : requested)

  // The effort the client's picker selected, passed to CodeBuddy as `--effort`.
  const wantedEffort = requestedEffort(body)
  const levels = (model?.efforts ?? []).filter((level) => EFFORT_LEVELS.includes(level))
  const rank = EFFORT_LEVELS.indexOf(wantedEffort)
  const effort = wantedEffort && levels.length
    ? [...levels].sort((a, b) => Math.abs(EFFORT_LEVELS.indexOf(a) - rank) - Math.abs(EFFORT_LEVELS.indexOf(b) - rank)
        || EFFORT_LEVELS.indexOf(b) - EFFORT_LEVELS.indexOf(a))[0]
    : wantedEffort

  // One conversation per account: Magpie routes a request to an account, and a
  // CodeBuddy process runs under exactly one account's token. Sharing a process
  // across accounts would answer as the wrong one, so the account is part of the
  // key that finds a live session.
  //
  // The effort is part of the key too: CodeBuddy takes it when the process starts
  // and keeps it for its whole life, so a turn asked for at another level needs
  // its own process rather than the one running at the previous level.
  const normalized = { ...canonical, model: modelId }
  const tools = normalizeTools(normalized)
  const allowNative = process.env.CODEBUDDY_BRIDGE_NATIVE_TOOLS !== "0"
  const skipPermissions = process.env.CODEBUDDY_BRIDGE_SKIP_PERMISSIONS === "1"
  const cwd = process.cwd()
  const configuration = createHash("sha256").update(JSON.stringify({
    tools, allowNative, skipPermissions, cwd, cli: launchKey(), system: systemText(normalized),
  })).digest("hex")
  const account = accountKeyOf(authToken)
  const spareKey = [account, modelId, effort || "-", configuration].join("\u0000")
  const convKey = spareKey + "\u0000" + conversationKey(canonical)
  const msgId = "msg_" + randomBytes(12).toString("hex")
  const { history, turn: lastMessage } = splitRequest(normalized)
  const sameHistory = (session) => Array.isArray(session.history)
    && session.history.length === history.length && historyExtends(history, session.history)

  const live = bridge.pool.peek(convKey)
  const results = toolResultsOf(normalized)
  if (results.some(({ call }) => call && call.session !== live)) {
    return jsonError(409, "this tool result belongs to a different account, model, or tool configuration")
  }

  // A tool round for a turn that is still open on a live session.
  //
  // This is checked before the history test: the request that carries a tool
  // result also carries the assistant turn that asked for it, so its history is
  // necessarily longer than what the session was left with. The held call is the
  // authority on whether it belongs here, not the transcript.
  if (results.length && live?.turn && !live.turn.finished) {
    if (live.turn.streaming || !sameHistory(live)) {
      return jsonError(409, "this tool result does not match the completed response history")
    }
    const ok = continueTurn(live, live.turn, results)
    if (!ok) return jsonError(409, "this tool result does not match the active CodeBuddy turn")
    live.busy = true
    live.history = [...history, lastMessage]
    return new Response(anthropicStream(live, live.turn, normalized, msgId, signal), {
      status: 200,
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
    })
  }
  // Resolve and validate everything that can fail before claiming a process.
  // A missing CLI or invalid tool schema must not leave an idle session busy.
  // A pinned CODEBUDDY_PATH that is unusable throws rather than falling back to
  // another install, so the message says what is wrong instead of "not found".
  let launch
  try {
    launch = await launchOf()
  } catch (error) {
    return jsonError(503, `the configured CodeBuddy CLI could not be used: ${error?.message ?? error}`)
  }
  if (!launch) {
    return jsonError(
      503,
      "the codebuddy CLI was not found on this machine. Install it with `npm install -g @tencent-ai/codebuddy-code`, or set CODEBUDDY_PATH to the CLI entry.",
    )
  }

  const factory = async () => {
    const { bridge: toolBridge, attach } = bridge.toolBridgeFor()
    toolBridge.setTools(tools)
    await toolBridge.start()
    let session
    try {
      session = await openCodeBuddySession({
        launch,
        argv: codebuddyLaunchArgs({
          model: modelId,
          // The effort the picker selected. CodeBuddy takes it per process, so a
          // session started at another level is not reused (see the effort check
          // below).
          effort,
          sessionPersistence: false,
          // `default` leaves each decision to this bridge (see decidePermission);
          // `dontAsk` would make the CLI refuse its own DeferExecuteTool before
          // the client's tool is ever reached.
          permissionMode: "default",
          skipPermissions,
        }),
        cwd,
        env: childEnv(authToken),
        mcpServers: toolBridge.port ? [toolBridge.serverEntry] : [],
        startTimeoutMs: envNumber("CODEBUDDY_BRIDGE_START_TIMEOUT_MS", START_TIMEOUT_MS),
      })
    } catch (error) {
      await toolBridge.close().catch(() => {})
      throw error
    }
    // From here on, a tool call from this process finds its own session.
    attach(session)
    session.toolBridge = toolBridge
    // Client tools run on the client through DeferExecuteTool. Native tools run
    // in the plugin host's working directory, which need not be the client's
    // project. Native tools are enabled by default; =0 disables them.
    session.setPermissionDecider((request) => decidePermission(request, { allowNative }))
    const stop = session.stop.bind(session)
    session.stop = async () => {
      await toolBridge.close().catch(() => {})
      await stop()
    }
    return session
  }

  let session
  const deadline = Date.now() + envNumber("CODEBUDDY_BRIDGE_QUEUE_MS", 300_000)
  try {
    for (;;) {
      if (signal?.aborted) throw new AcpCancelledError()
      const existing = bridge.pool.peek(convKey)
      try {
        const acquired = await bridge.pool.acquire({
          convKey, history, factory, spareKey,
          forceNew: Boolean(existing) && !sameHistory(existing),
        })
        session = acquired.session
        break
      } catch (error) {
        const current = bridge.pool.peek(convKey)
        if (error?.statusCode !== 503 || !current || (!current.busy && (!current.turn || current.turn.finished))) throw error
        const remaining = deadline - Date.now()
        if (remaining <= 0) throw error
        const waited = await bridge.pool.awaitTurn(convKey, remaining, signal)
        if (signal?.aborted) {
          if (waited) waited.busy = false
          throw new AcpCancelledError()
        }
        if (!waited) {
          if (Date.now() >= deadline) throw Object.assign(new Error("CodeBuddy is still answering an earlier request for this conversation; try again"), { statusCode: 503 })
          // Another queued request may have retired the old process to replay its
          // own history. Join acquisition again rather than treating that as timeout.
          continue
        }
        // The previous stream has now committed its assistant message. Compare
        // again: a retry with older history must replay on a fresh process.
        if (sameHistory(waited)) {
          session = waited
          break
        }
        waited.busy = false
      }
    }
  } catch (error) {
    if (error instanceof AcpCancelledError) throw error
    return jsonError(error?.statusCode ?? 502, error?.message ?? "unable to start CodeBuddy")
  }

  // Keep the request transcript before starting: stop() below commits the exact
  // assistant content delivered by this stream, including tool-use responses.
  session.history = [...history, lastMessage]
  try {
    startTurn(session, convKey, normalized, { history, turn: lastMessage })
  } catch (error) {
    session.busy = false
    await session.stop().catch(() => {})
    throw error
  }
  void bridge.pool.prewarm(factory, spareKey)

  // A turn that fails before producing anything (a refused account, say) must
  // answer with a real HTTP status, which a stream that has already started
  // cannot do. Give it a short window to report that failure, then stream.
  //
  // The window must stay short: while it runs the client has received nothing at
  // all, and an agent shows that as its own spinner with no progress. A refused
  // account answers at once, so a couple of seconds is enough to catch it.
  try {
    const first = await session.peekNext(envNumber("CODEBUDDY_BRIDGE_FIRST_EVENT_MS", 2500), signal)
    if (first?.type === "turn-error") {
      session.turn.finished = true
      session.busy = false
      await session.stop().catch(() => {})
      const error = first.error
      const status = error?.status === 401 || error?.status === 403 ? 401 : error?.status || 502
      const message = status === 401
        ? "CodeBuddy rejected the account. Sign in to this account again in Magpie's Providers page."
        : String(error?.message ?? error ?? "CodeBuddy request failed")
      return jsonError(status, message)
    }
  } catch (error) {
    session.turn.finished = true
    session.busy = false
    session.cancel()
    await session.stop().catch(() => {})
    if (signal?.aborted) throw new AcpCancelledError()
    throw error
  }

  return new Response(anthropicStream(session, session.turn, normalized, msgId, signal), {
    status: 200,
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
  })
}

/** A non-streaming request answered from the stream. */
async function collectJson(stream) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  const content = []
  const usage = { input_tokens: 0, output_tokens: 0 }
  let stopReason = null
  let model = ""
  let id = ""
  let index = -1
  const blocks = new Map()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      for (;;) {
        const split = buffer.indexOf("\n\n")
        if (split < 0) break
        const raw = buffer.slice(0, split)
        buffer = buffer.slice(split + 2)
        const line = raw.split("\n").find((entry) => entry.startsWith("data: "))
        if (!line) continue
        let event
        try {
          event = JSON.parse(line.slice(6))
        } catch {
          continue
        }
        if (event.type === "message_start") {
          id = event.message?.id ?? id
          model = event.message?.model ?? model
        } else if (event.type === "content_block_start") {
          index = event.index
          blocks.set(index, { ...event.content_block })
        } else if (event.type === "content_block_delta") {
          const block = blocks.get(event.index)
          if (!block) continue
          const delta = event.delta ?? {}
          if (delta.type === "text_delta") block.text = (block.text ?? "") + delta.text
          else if (delta.type === "thinking_delta") block.thinking = (block.thinking ?? "") + delta.thinking
          else if (delta.type === "signature_delta") block.signature = delta.signature
          else if (delta.type === "input_json_delta") block.__json = (block.__json ?? "") + delta.partial_json
        } else if (event.type === "content_block_stop") {
          const block = blocks.get(index)
          if (block?.__json) {
            try {
              block.input = JSON.parse(block.__json)
            } catch {
              block.input = {}
            }
            delete block.__json
          }
        } else if (event.type === "message_delta") {
          stopReason = event.delta?.stop_reason ?? stopReason
          if (event.usage) Object.assign(usage, event.usage)
        } else if (event.type === "error") {
          throw new Error(event.error?.message ?? "CodeBuddy request failed")
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
  for (const block of blocks.values()) {
    delete block.__json
    content.push(block)
  }
  return {
    id,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: stopReason ?? "end_turn",
    stop_sequence: null,
    usage,
  }
}

// ---- the plugin ----------------------------------------------------------

/** Whether the CLI is signed in: a session can be opened and lists models. */
async function probeSignedIn() {
  const launch = await launchOf()
  if (!launch) return { ok: false, why: "the codebuddy CLI was not found" }
  let session = null
  try {
    session = await openCodeBuddySession({
      launch,
      argv: codebuddyLaunchArgs({ sessionPersistence: false }),
      cwd: process.cwd(),
      env: childEnv(),
      startTimeoutMs: envNumber("CODEBUDDY_BRIDGE_START_TIMEOUT_MS", START_TIMEOUT_MS),
    })
    const models = modelsFromSession(session)
    if (!models.length) return { ok: false, why: "CodeBuddy listed no models for this account" }
    catalog = models
    catalogAt = Date.now()
    return { ok: true, models }
  } catch (error) {
    return { ok: false, why: String(error?.message ?? error) }
  } finally {
    await session?.stop().catch(() => {})
  }
}

export const CodeBuddyCliPlugin = async () => {
  const bridge = new Bridge()
  const signIn = new CodeBuddySignIn()

  // The token each account's requests run under. Magpie scopes every call to one
  // account and hands the loader that account's credential; `getAuth()` reads it
  // again per call, so an account switched or renewed mid-conversation is picked
  // up without a restart.
  const tokenOf = async (getAuth) => {
    if (typeof getAuth === "function") {
      try {
        const auth = await getAuth()
        const stored = validToken(auth?.access ?? auth?.key)
        if (stored) return stored
      } catch {
        // Fall through to the machine-wide token, if one is configured.
      }
    }
    return readToken()
  }

  return {
    auth: {
      provider: PROVIDER_ID,
      // Several accounts, one per CodeBuddy sign-in: Magpie keeps each under its
      // own key and routes across them (smart, order, rotate, …). Not `single`.
      methods: [
        {
          type: "oauth",
          label: "Sign in with CodeBuddy",
          // The browser sign-in CodeBuddy's own CLI and desktop app use. Each
          // completed sign-in becomes another account.
          authorize: async () => {
            const started = await signIn.start().catch((error) => {
              throw error instanceof SignInError ? error : new SignInError(String(error?.message ?? error))
            })
            return {
              url: started.url,
              instructions:
                "Sign in to CodeBuddy in the browser that opens. This page keeps waiting; nothing needs to be pasted.",
              method: "auto",
              callback: async () => {
                // Magpie calls this once and waits; poll until CodeBuddy hands
                // over the account's token or the flow expires.
                const deadline = Date.now() + started.expiresIn * 1000
                for (;;) {
                  const got = await signIn.poll(started.state)
                  if (got) {
                    const { token, identity } = got
                    // Magpie stores this as the account's credential. The token
                    // is the account; the id and name are how Magpie tells two
                    // accounts apart and labels them.
                    return {
                      type: "success",
                      access: token,
                      refresh: "",
                      expires: identity.expires,
                      ...(identity.uid ? { uid: identity.uid } : {}),
                      ...(identity.name ? { accountId: identity.name } : {}),
                      ...(identity.email ? { metadata: { email: identity.email } } : {}),
                    }
                  }
                  if (Date.now() >= deadline) {
                    signIn.cancel()
                    return { type: "failed", error: "the CodeBuddy sign-in expired; start it again" }
                  }
                  await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_S * 1000))
                }
              },
            }
          },
        },
        {
          // A token copied from a CodeBuddy session, for an account the browser
          // flow cannot reach (an enterprise deployment, a headless machine).
          type: "api",
          label: "Paste an access token",
          placeholder: "eyJhbGciOi…",
          async authorize(inputs) {
            const token = validToken(inputs?.key ?? inputs?.token ?? inputs?.accessToken)
            if (!token) return { type: "failed", error: "that is not a CodeBuddy access token" }
            const identity = tokenIdentity(token)
            return {
              type: "success",
              key: token,
              ...(identity.uid || identity.name ? { metadata: { uid: identity.uid, name: identity.name, email: identity.email } } : {}),
            }
          },
        },
      ],
      // Magpie scopes this callback to the account being refreshed. Never fall
      // back to the machine's login when a configured account lacks credentials.
      async usage(getAuth) {
        try {
          if (typeof getAuth !== "function") return creditUsage(readToken())
          const auth = await getAuth()
          const token = validToken(auth?.access ?? auth?.key)
          return creditUsage(token, { uid: auth?.uid ?? auth?.metadata?.uid })
        } catch {
          return { error: "无法读取此 CodeBuddy 账号的授权，请重新授权。", signIn: "kept" }
        }
      },
      loader: async (getAuth) => ({
        baseURL: VIRTUAL_BASE,
        apiKey: "codebuddy-cli",
        fetch: async (input, init = {}) => {
          const url =
            typeof input === "string"
              ? input
              : input instanceof URL
                ? input.href
                : input?.url ?? String(input)
          const rawBody =
            typeof init.body === "string"
              ? init.body
              : init.body
                ? new TextDecoder().decode(init.body)
                : typeof input?.text === "function"
                  ? await input.text()
                  : ""
          let body
          try {
            body = rawBody ? JSON.parse(rawBody) : {}
          } catch {
            return jsonError(400, "the request body is not valid JSON")
          }
          if (/\/count[_-]tokens(?:$|[/?#])/i.test(url)) {
            if (!Array.isArray(body?.messages)) return jsonError(400, "invalid count_tokens request")
            return handleCountTokens(body)
          }
          // This request's account, read per call: the same loader serves every
          // account, and Magpie routes between them.
          const token = await tokenOf(getAuth)
          try {
            const response = await handleMessages(body, init.signal, bridge, token)
            if (body.stream === false && response.ok) {
              return new Response(JSON.stringify(await collectJson(response.body)), {
                status: 200,
                headers: { "Content-Type": "application/json" },
              })
            }
            return response
          } catch (error) {
            if (error instanceof UnsupportedContent) return jsonError(400, error.message)
            if (error instanceof AcpCancelledError) return jsonError(499, "the request was cancelled")
            if (error instanceof AcpTurnError) {
              const status = error.status === 401 || error.status === 403 ? 401 : error.status || 502
              const message =
                status === 401
                  ? "CodeBuddy rejected this account. Sign in to it again from Magpie's Providers page, or run `codebuddy` in a terminal and use /login."
                  : error.message
              return jsonError(status, message)
            }
            return jsonError(error?.statusCode ?? 502, error?.message ?? "CodeBuddy request failed")
          }
        },
      }),
    },
    provider: {
      id: PROVIDER_ID,
      npm: NPM_ANTHROPIC,
      // Magpie asks this once per account with that account's credential, so the
      // list is what the account can actually serve.
      models: async (_provider, context = {}) => {
        const token = validToken(context?.auth?.access ?? context?.auth?.key)
        const models = token ? await catalogFor(token) : await currentCatalog()
        const out = {}
        for (const model of models) {
          out[model.id] = {
            id: model.id,
            name: model.name,
            npm: NPM_ANTHROPIC,
            api: { id: model.id, url: VIRTUAL_BASE, npm: NPM_ANTHROPIC },
            limit: {
              context: model.context ?? 128000,
              // Anthropic clients share this allowance between thought and text.
              // 8192 clips DSH's high budget (16384) to 7168, which Magpie reads
              // as medium. ACP has no max_tokens knob; avoid inventing that cap.
              output: model.output ?? (model.reasoning ? 32768 : 8192),
            },
            capabilities: {
              ...(model.images ? { attachment: true, input: { text: true, image: true }, output: { text: true } } : {}),
              ...(model.reasoning ? { reasoning: true } : {}),
            },
            ...(model.reasoning && model.efforts?.length
              ? {
                  variants: Object.fromEntries(
                    // The variant carries the effort as `reasoningEffort`, which is
                    // how magpie tells the provider what the picker selected; an
                    // empty settings object would select nothing.
                    model.efforts.map((effort) => [effort, { reasoningEffort: effort }]),
                  ),
                }
              : {}),
          }
        }
        return out
      },
    },
    // Magpie's own hook; OpenCode ignores it.
    usage: async () => ({
      provider: PROVIDER_ID,
      ...(catalogError ? { error: catalogError } : {}),
    }),
    dispose: async () => {
      await bridge.close()
    },
  }
}

export default { id: PROVIDER_ID, server: CodeBuddyCliPlugin }

// Kept for the tests, which drive the same translation the plugin does.
export const _internal = {
  PROVIDER_ID,
  VIRTUAL_BASE,
  childEnv,
  modelsFromSession,
  resolveModel,
  handleMessages,
  anthropicStream,
  toolResultsOf,
  toolResultValue,
  startTurn,
  continueTurn,
  fallbackCatalog,
  probeSignedIn,
}
