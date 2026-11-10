#!/usr/bin/env node
/**
 * Fake Tencent CodeBuddy CLI -- an ACP (Agent Client Protocol) *agent* speaking
 * JSON-RPC 2.0 over NDJSON on stdin/stdout.
 *
 * Purpose: hermetic tests for the Magpie <-> CodeBuddy bridge. No real CLI, no
 * network, no credits. Every protocol shape below was copied from a live probe of
 * codebuddy 2.181.0 (see the task notes), so the bridge can be developed against
 * something that behaves like the real thing.
 *
 * Usage:
 *   FAKE_ACP_SCENARIO_FILE=/path/scenario.json node test/fake-acp.mjs
 *   FAKE_ACP_SCENARIO='{"prompts":[{"text":["hi"]}]}' node test/fake-acp.mjs
 *
 * Rules honoured here:
 *   - stdout carries protocol lines ONLY. All diagnostics go to stderr.
 *   - exits cleanly on stdin EOF/close and on SIGTERM/SIGINT.
 *   - a scenario may ask for an MCP server list; those are connected over plain
 *     HTTP (POST + JSON) exactly like the real CLI does, and failures are
 *     non-fatal.
 */

import { randomUUID } from 'node:crypto'
import { appendFileSync, readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const jsonClone = (v) => JSON.parse(JSON.stringify(v))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function numberOr(value, fallback) {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : fallback
}

/** Normalise "string | string[] | undefined" into an array of text deltas. */
function asDeltas(value) {
  if (value === undefined || value === null) return []
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.filter((v) => v !== undefined && v !== null).map((v) => String(v))
  return [String(value)]
}

function parseJsonText(text) {
  const raw = String(text ?? '').trim()
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// scenario loading
// ---------------------------------------------------------------------------

function loadScenario() {
  const fromFile = {}
  const filePath = process.env.FAKE_ACP_SCENARIO_FILE
  if (filePath) {
    let text
    try {
      text = readFileSync(filePath, 'utf8')
    } catch (err) {
      process.stderr.write(`fake-acp: cannot read FAKE_ACP_SCENARIO_FILE (${filePath}): ${err.message}\n`)
      process.exit(1)
    }
    try {
      const parsed = JSON.parse(text)
      if (isObject(parsed)) Object.assign(fromFile, parsed)
    } catch (err) {
      process.stderr.write(`fake-acp: FAKE_ACP_SCENARIO_FILE is not valid JSON: ${err.message}\n`)
      process.exit(1)
    }
  }

  const inline = process.env.FAKE_ACP_SCENARIO
  if (inline && inline.trim()) {
    let parsed
    try {
      parsed = JSON.parse(inline)
    } catch (err) {
      process.stderr.write(`fake-acp: FAKE_ACP_SCENARIO is not valid JSON: ${err.message}\n`)
      process.exit(1)
    }
    if (isObject(parsed)) Object.assign(fromFile, parsed)
  }

  return fromFile
}

const scenario = loadScenario()

// ---------------------------------------------------------------------------
// protocol constants (verified against codebuddy 2.181.0)
// ---------------------------------------------------------------------------

const PROTOCOL_VERSION = 1
const CLI_VERSION = String(scenario.version ?? '2.181.0')

const DEFAULT_MODELS = [
  {
    modelId: 'hy3',
    name: 'Hy3',
    description: 'x0.00 credits',
    _meta: {
      supportsImages: true,
      supportsReasoning: true,
      credits: 'x0.00 credits',
      maxInputTokens: 192000,
      effortOptions: [
        { value: 'low', name: 'Low' },
        { value: 'medium', name: 'Medium' },
        { value: 'high', name: 'High' },
        { value: 'xhigh', name: 'X-High' },
      ],
    },
  },
  {
    modelId: 'deepseek-v4.1-flash',
    name: 'DeepSeek-V4.1-Flash',
    description: 'x0.11 credits',
    _meta: {
      supportsImages: true,
      supportsReasoning: true,
      credits: 'x0.11 credits',
      maxInputTokens: 1000000,
      effortOptions: [
        { value: 'low', name: 'Low' },
        { value: 'high', name: 'High' },
      ],
    },
  },
]

const DEFAULT_MODES = [
  { id: 'default', name: 'Always Ask', description: 'Ask before running tools.' },
  { id: 'acceptEdits', name: 'Accept Edits', description: 'Auto-approve file edits.' },
  { id: 'plan', name: 'Plan', description: 'Read-only planning mode.' },
]

const DEFAULT_PERMISSION_OPTIONS = [
  { kind: 'allow_always', name: 'Always Allow', optionId: 'allow_always' },
  { kind: 'allow_once', name: 'Allow', optionId: 'allow' },
  { kind: 'reject_once', name: 'Reject', optionId: 'reject' },
]

/** The exact auth failure string the real CLI puts into codebuddy.ai/errorMessage. */
const DEFAULT_AUTH_ERROR = JSON.stringify({
  code: -32000,
  message: 'Authentication required',
  data: { statusCode: 401, category: 'auth' },
})

const RECORD_PATH = typeof scenario.recordPath === 'string' && scenario.recordPath ? scenario.recordPath : null

// ---------------------------------------------------------------------------
// stdout writer (protocol only) / stderr diagnostics
// ---------------------------------------------------------------------------

let pendingWrites = 0
let exiting = false

process.stdout.on('error', () => {
  /* parent went away; nothing useful to do */
})

function send(message) {
  if (exiting) return
  const line = `${JSON.stringify(message)}\n`
  pendingWrites += 1
  try {
    process.stdout.write(line, () => {
      pendingWrites -= 1
    })
  } catch {
    pendingWrites -= 1
  }
}

function sendResult(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function sendError(id, code, message, data) {
  const error = { code, message }
  if (data !== undefined) error.data = data
  send({ jsonrpc: '2.0', id, error })
}

function sendNotification(method, params) {
  send({ jsonrpc: '2.0', method, params })
}

function emitUpdate(sessionId, update) {
  sendNotification('session/update', { sessionId, update })
}

function writeStderr(text) {
  if (text === undefined || text === null || text === '') return
  try {
    const value = String(text)
    process.stderr.write(value.endsWith('\n') ? value : `${value}\n`)
  } catch {
    /* ignore */
  }
}

async function flushStdout() {
  if (pendingWrites <= 0) return
  await new Promise((resolve) => {
    try {
      process.stdout.write('', resolve)
    } catch {
      resolve()
    }
  })
}

async function flushAndExit(code) {
  if (exiting) return
  exiting = true
  await flushStdout()
  process.exit(code)
}

// ---------------------------------------------------------------------------
// record file (every inbound line, as JSON)
// ---------------------------------------------------------------------------

function recordInbound(rawLine) {
  if (!RECORD_PATH) return
  const payload = parseJsonText(rawLine) ?? { raw: rawLine }
  appendRecord(payload)
}

function appendRecord(payload) {
  if (!RECORD_PATH) return
  try {
    appendFileSync(RECORD_PATH, `${JSON.stringify(payload)}\n`)
  } catch (err) {
    writeStderr(`fake-acp: cannot append to recordPath: ${err.message}`)
  }
}

function recordMcpFailure(entry) {
  if (!RECORD_PATH) return
  appendRecord({ __fakeAcp: true, type: 'mcp-error', name: entry.name ?? null, url: entry.url ?? null, error: entry.error ?? null })
}

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

const modelsList = buildModels()
const modesList = Array.isArray(scenario.modes) && scenario.modes.length > 0 ? jsonClone(scenario.modes) : DEFAULT_MODES

const state = {
  sessionId: null,
  currentModelId: typeof scenario.currentModelId === 'string' ? scenario.currentModelId : DEFAULT_MODELS[0].modelId,
  promptIndex: 0,
  turnSeq: 0,
  toolSeq: 0,
  mcpIdSeq: 100,
  /** @type {Array<{name:string,url:string,headers:Record<string,string>,ok:boolean,tools:any[],error:string|null}>} */
  mcp: [],
  mcpReady: Promise.resolve(),
  agentRequestSeq: 99,
}

/** Pending requests WE sent to the client (permission prompts). */
const pendingAgentRequests = new Map()

function buildModels() {
  const source = Array.isArray(scenario.models) && scenario.models.length > 0 ? scenario.models : DEFAULT_MODELS
  const models = source.map((model) => jsonClone(model))
  if (typeof scenario.supportsImages === 'boolean') {
    for (const model of models) {
      model._meta = { ...(isObject(model._meta) ? model._meta : {}), supportsImages: scenario.supportsImages }
    }
  }
  return models
}

function buildCapabilities() {
  const base = {
    promptCapabilities: { image: true, embeddedContext: true },
    mcpCapabilities: { http: true, sse: true },
    loadSession: true,
    delegateToolsSupport: true,
    mainAgentSupport: false,
    multitaskSupport: true,
    toolModeSupport: false,
    codeModeSupport: false,
    metaPromptSupport: true,
  }
  return isObject(scenario.agentCapabilities) ? { ...base, ...jsonClone(scenario.agentCapabilities) } : base
}

/**
 * The verified session/new configOptions carry only the *current* mode option and
 * empty option lists for model / thought_level (the full model list lives in
 * models.availableModels). Reproduce that, unless the scenario overrides it.
 */
function buildConfigOptions() {
  if (Array.isArray(scenario.configOptions)) return jsonClone(scenario.configOptions)
  const firstMode = modesList[0]
  return [
    {
      type: 'select',
      id: 'mode',
      name: 'Permission Mode',
      category: 'mode',
      currentValue: firstMode?.id ?? 'default',
      options: firstMode ? [{ value: firstMode.id, name: firstMode.name }] : [],
    },
    { type: 'select', id: 'model', name: 'Model', category: 'model', currentValue: state.currentModelId, options: [] },
    { type: 'select', id: 'thought_level', name: 'Thought Level', category: 'thought_level', currentValue: 'medium', options: [] },
  ]
}

// ---------------------------------------------------------------------------
// MCP client (plain fetch; failures are non-fatal)
// ---------------------------------------------------------------------------

function mcpHeaders(raw) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }
  if (Array.isArray(raw)) {
    for (const header of raw) {
      if (isObject(header) && typeof header.name === 'string') headers[header.name] = String(header.value ?? '')
    }
  } else if (isObject(raw)) {
    for (const [key, value] of Object.entries(raw)) headers[key] = String(value)
  }
  return headers
}

async function mcpPost(url, body, headers, timeoutMs = 5000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    const text = await response.text()
    return { status: response.status, text }
  } finally {
    clearTimeout(timer)
  }
}

function connectMcpServers(servers) {
  const list = Array.isArray(servers) ? servers : []
  const tasks = list.map((server) => connectMcpServer(server))
  return Promise.allSettled(tasks).then(() => state.mcp)
}

async function connectMcpServer(server) {
  const entry = {
    name: isObject(server) && typeof server.name === 'string' ? server.name : 'mcp',
    url: isObject(server) && typeof server.url === 'string' ? server.url : '',
    headers: {},
    ok: false,
    tools: [],
    error: null,
  }
  state.mcp.push(entry)

  if (!entry.url) {
    entry.error = 'missing url'
    recordMcpFailure(entry)
    return entry
  }

  const type = String(isObject(server) ? (server.type ?? 'http') : 'http').toLowerCase()
  if (!['http', 'streamable-http', 'streamablehttp', 'streamable_http'].includes(type)) {
    entry.error = `unsupported mcp transport: ${type}`
    recordMcpFailure(entry)
    return entry
  }

  entry.headers = mcpHeaders(isObject(server) ? server.headers : undefined)

  try {
    const initResponse = await mcpPost(entry.url, {
      jsonrpc: '2.0',
      id: state.mcpIdSeq++,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'codebuddy', version: CLI_VERSION },
      },
    }, entry.headers)
    if (initResponse.status >= 400) throw new Error(`initialize HTTP ${initResponse.status}`)
    const initPayload = parseJsonText(initResponse.text)
    if (initPayload?.error) throw new Error(`initialize error: ${JSON.stringify(initPayload.error)}`)

    // notifications/initialized has no id; a 202 / empty body is fine.
    try {
      await mcpPost(entry.url, { jsonrpc: '2.0', method: 'notifications/initialized' }, entry.headers)
    } catch {
      /* tolerated by design */
    }

    const listResponse = await mcpPost(entry.url, {
      jsonrpc: '2.0',
      id: state.mcpIdSeq++,
      method: 'tools/list',
      params: {},
    }, entry.headers)
    const listPayload = parseJsonText(listResponse.text)
    const tools = listPayload?.result?.tools
    entry.tools = Array.isArray(tools) ? tools : []
    entry.ok = true
  } catch (err) {
    entry.ok = false
    entry.error = String(err?.message ?? err)
    recordMcpFailure(entry)
  }

  return entry
}

// ---------------------------------------------------------------------------
// agent -> client requests
// ---------------------------------------------------------------------------

function agentRequest(method, params, timeoutMs = 30000) {
  const id = state.agentRequestSeq++
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (pendingAgentRequests.delete(id)) {
        writeStderr(`fake-acp: agent request ${method}#${id} timed out`)
        resolve({ error: { code: -32001, message: 'agent request timed out' } })
      }
    }, timeoutMs)
    pendingAgentRequests.set(id, (value) => {
      clearTimeout(timer)
      resolve(value)
    })
    send({ jsonrpc: '2.0', id, method, params })
  })
}

// ---------------------------------------------------------------------------
// initialize / session handlers
// ---------------------------------------------------------------------------

function handleInitialize(id) {
  if (scenario.failInitialize) {
    writeStderr('fake-acp: failInitialize scenario - exiting 1 before the initialize response')
    void flushAndExit(1)
    return
  }
  const result = {
    protocolVersion: PROTOCOL_VERSION,
    agentCapabilities: buildCapabilities(),
    authMethods: jsonClone(
      Array.isArray(scenario.authMethods)
        ? scenario.authMethods
        : [{ id: 'external', name: 'Login with Google/Github', description: null }],
    ),
  }
  // The live probe of codebuddy 2.181.0 returned no agentInfo field, so it is
  // opt-in only: a scenario may pass `agentInfo: {name, version}` to add it.
  if (isObject(scenario.agentInfo)) result.agentInfo = jsonClone(scenario.agentInfo)
  sendResult(id, result)
}

function handleSessionNew(id, params, options = {}) {
  const p = isObject(params) ? params : {}
  const sessionId = options.reuseId && typeof p.sessionId === 'string' && p.sessionId ? p.sessionId : randomUUID()
  state.sessionId = sessionId
  if (scenario.recordSessions) appendRecord({ __fakeAcp: true, type: 'session-opened', sessionId,
    argv: process.argv.slice(2), mcpServers: p.mcpServers ?? [] })

  // VERIFIED: the real CLI emits this metadata notification *before* the
  // session/new response, already carrying the id it is about to return.
  emitUpdate(sessionId, { sessionUpdate: 'config_option_update', configOptions: buildConfigOptions() })

  state.mcp = []
  state.mcpReady = connectMcpServers(p.mcpServers)

  sendResult(id, {
    sessionId,
    models: { currentModelId: state.currentModelId, availableModels: modelsList },
    modes: { availableModes: modesList },
    configOptions: buildConfigOptions(),
    multitaskOn: false,
  })
}

function handleSetModel(id, params) {
  const modelId = isObject(params) && typeof params.modelId === 'string' ? params.modelId : undefined
  const known = modelId !== undefined && modelsList.some((model) => model.modelId === modelId)
  if (!known) {
    sendError(id, -32602, 'unknown model')
    return
  }
  state.currentModelId = modelId
  sendResult(id, { modelId })
}

// ---------------------------------------------------------------------------
// prompt turn
// ---------------------------------------------------------------------------

function promptSpecFor(index) {
  const list = Array.isArray(scenario.prompts) ? scenario.prompts : []
  const fallback = scenario.fallbackPrompt ?? { text: ['ok'] }
  const spec = list[index] ?? fallback
  return typeof spec === 'string' ? { text: [spec] } : isObject(spec) ? spec : { text: ['ok'] }
}

function buildMeta(spec, stopReason) {
  const meta = {}
  meta['codebuddy.ai/requestId'] = spec.requestId ?? `r${state.turnSeq}`
  meta['codebuddy.ai/finishReason'] = spec.finishReason ?? (stopReason === 'end_turn' ? 'stop' : String(stopReason))
  if (spec.authFailure === true && spec.outcome === undefined) {
    meta['codebuddy.ai/outcome'] = 'FAILED_MODEL_REQUEST'
    meta['codebuddy.ai/errorMessage'] =
      typeof spec.errorMessage === 'string' ? spec.errorMessage : DEFAULT_AUTH_ERROR
  } else {
    meta['codebuddy.ai/outcome'] = spec.outcome ?? 'SUCCESS'
    if (spec.errorMessage !== undefined) {
      meta['codebuddy.ai/errorMessage'] =
        typeof spec.errorMessage === 'string' ? spec.errorMessage : JSON.stringify(spec.errorMessage)
    }
  }
  if (isObject(spec.meta)) Object.assign(meta, spec.meta)
  return meta
}

async function requestPermission(sessionId, permission) {
  const p = isObject(permission) ? permission : {}
  const toolCall = {
    toolCallId: p.toolCallId ?? p.id ?? 'call_1',
    title: p.title ?? 'Bash',
    rawInput: isObject(p.rawInput) ? p.rawInput : {},
  }
  if (typeof p.kind === 'string') toolCall.kind = p.kind

  const options = Array.isArray(p.options) && p.options.length > 0 ? jsonClone(p.options) : DEFAULT_PERMISSION_OPTIONS
  const reply = await agentRequest(
    'session/request_permission',
    { sessionId, toolCall, options },
    numberOr(p.timeoutMs, 30000),
  )

  if (!reply || reply.error) return false
  const outcome = reply.result?.outcome ?? {}
  if (outcome.outcome === 'cancelled') return false
  const optionId = String(outcome.optionId ?? '')
  const selected = options.find((option) => option.optionId === optionId)
  const kind = String(selected?.kind ?? '')
  if (kind.startsWith('reject') || /^reject/i.test(optionId)) return false
  return true
}

function emitTool(sessionId, tool) {
  const t = isObject(tool) ? tool : {}
  const toolCallId = t.id ?? t.toolCallId ?? `call_${++state.toolSeq}`
  const finalStatus = typeof t.status === 'string' ? t.status : 'completed'
  const startStatus = finalStatus === 'pending' || finalStatus === 'in_progress' ? finalStatus : 'in_progress'

  emitUpdate(sessionId, {
    sessionUpdate: 'tool_call',
    toolCallId,
    title: t.name ?? t.title ?? 'Bash',
    kind: t.kind ?? 'execute',
    status: startStatus,
    rawInput: isObject(t.rawInput) ? t.rawInput : {},
  })

  if (startStatus !== finalStatus) {
    emitUpdate(sessionId, {
      sessionUpdate: 'tool_call_update',
      toolCallId,
      status: finalStatus,
      rawOutput: t.rawOutput === undefined ? '' : t.rawOutput,
    })
  }
}

function emitUsage(sessionId, usage) {
  const u = isObject(usage) ? usage : {}
  const promptTokens = numberOr(u.prompt_tokens ?? u.promptTokens, 24805)
  const completionTokens = numberOr(u.completion_tokens ?? u.completionTokens, 799)
  const reasoningTokens = numberOr(
    u.reasoning_tokens ?? u.reasoningTokens ?? u.completion_tokens_details?.reasoning_tokens,
    57,
  )
  const totalTokens = numberOr(u.total_tokens ?? u.totalTokens, promptTokens + completionTokens)
  // Defaults mirror the verified probe exactly: used == prompt_tokens, size == 1000000.
  const size = numberOr(u.size, 1000000)
  const amount = numberOr(u.costAmount ?? u.cost?.amount, 0.05)

  emitUpdate(sessionId, {
    sessionUpdate: 'usage_update',
    used: numberOr(u.used, promptTokens),
    size,
    cost: { amount, currency: typeof u.currency === 'string' ? u.currency : '' },
    _meta: {
      'codebuddy.ai/usage': {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: totalTokens,
        completion_tokens_details: { reasoning_tokens: reasoningTokens },
      },
    },
  })
}

function emitNoise(sessionId) {
  emitUpdate(sessionId, { sessionUpdate: 'session_info_update', title: 'fake session', updatedAt: new Date().toISOString() })
  emitUpdate(sessionId, {
    sessionUpdate: 'available_commands_update',
    availableCommands: [{ name: 'help', description: 'Show help' }],
  })
  emitUpdate(sessionId, { sessionUpdate: 'config_option_update', configOptions: buildConfigOptions() })
}

async function runMcpToolCall(sessionId, call, messageId) {
  const c = isObject(call) ? call : {}
  const name = String(c.name ?? 'tool')
  const args = isObject(c.arguments) ? c.arguments : {}
  const toolCallId = c.id ?? `mcp_${++state.toolSeq}`

  emitUpdate(sessionId, {
    sessionUpdate: 'tool_call',
    toolCallId,
    title: c.title ?? `mcp:${name}`,
    kind: 'execute',
    status: 'in_progress',
    rawInput: args,
  })

  const server =
    state.mcp.find((entry) => entry.ok && entry.tools.some((tool) => tool?.name === name)) ??
    state.mcp.find((entry) => entry.ok)

  if (!server) {
    emitUpdate(sessionId, {
      sessionUpdate: 'tool_call_update',
      toolCallId,
      status: 'failed',
      rawOutput: 'no MCP server available',
    })
    return
  }

  try {
    const response = await mcpPost(server.url, {
      jsonrpc: '2.0',
      id: state.mcpIdSeq++,
      method: 'tools/call',
      params: { name, arguments: args },
    }, server.headers)
    const payload = parseJsonText(response.text)
    if (payload?.error) throw new Error(String(payload.error.message ?? 'tools/call failed'))

    const content = Array.isArray(payload?.result?.content) ? payload.result.content : []
    const text = content
      .filter((item) => item?.type === 'text')
      .map((item) => String(item.text ?? ''))
      .join('\n')

    emitUpdate(sessionId, { sessionUpdate: 'tool_call_update', toolCallId, status: 'completed', rawOutput: text })
    // Fold the tool result into the turn's visible output.
    if (c.fold !== false) {
      emitUpdate(sessionId, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text },
        messageId,
      })
    }
  } catch (err) {
    const message = String(err?.message ?? err)
    emitUpdate(sessionId, { sessionUpdate: 'tool_call_update', toolCallId, status: 'failed', rawOutput: message })
    recordMcpFailure({ name: `tools/call:${name}`, url: server.url, error: message })
  }
}

async function runTurn(requestId, params) {
  const p = isObject(params) ? params : {}
  const sessionId = typeof p.sessionId === 'string' && p.sessionId ? p.sessionId : state.sessionId
  const spec = promptSpecFor(state.promptIndex++)
  state.turnSeq += 1
  const userMessageId = randomUUID()

  const delayMs = numberOr(spec.delayMs, 0)
  if (delayMs > 0) await sleep(delayMs)

  if (spec.permission) {
    const approved = await requestPermission(sessionId, spec.permission)
    if (!approved) {
      sendResult(requestId, { stopReason: 'cancelled', userMessageId, _meta: buildMeta(spec, 'cancelled') })
      await finishTurn()
      return
    }
  }

  if (spec.noise === true || (spec.noise !== false && scenario.noiseNotifications === true)) {
    emitNoise(sessionId)
  }

  const messageId = randomUUID()
  const thoughtMessageId = randomUUID()
  const deltaDelay = numberOr(spec.deltaDelayMs, 0)

  for (const delta of asDeltas(spec.thinking)) {
    emitUpdate(sessionId, {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: delta },
      messageId: thoughtMessageId,
    })
    if (deltaDelay > 0) await sleep(deltaDelay)
  }

  for (const delta of asDeltas(spec.text ?? spec.content)) {
    emitUpdate(sessionId, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: delta },
      messageId,
    })
    if (deltaDelay > 0) await sleep(deltaDelay)
  }

  for (const tool of Array.isArray(spec.tools) ? spec.tools : []) emitTool(sessionId, tool)

  const mcpCalls = Array.isArray(spec.mcpCalls) ? spec.mcpCalls : []
  if (mcpCalls.length > 0) {
    // The MCP handshake runs in the background after session/new; wait for it.
    await state.mcpReady
    for (const call of mcpCalls) await runMcpToolCall(sessionId, call, messageId)
  }

  if (spec.usage) emitUsage(sessionId, spec.usage)

  const stopReason = typeof spec.stopReason === 'string' ? spec.stopReason : 'end_turn'
  if (scenario.recordSessions) appendRecord({ __fakeAcp: true, type: 'prompt-finished', sessionId })
  sendResult(requestId, { stopReason, userMessageId, _meta: buildMeta(spec, stopReason) })

  await finishTurn()
}

async function finishTurn() {
  if (scenario.exitAfterPrompts === true) {
    await flushAndExit(0)
  }
}

// ---------------------------------------------------------------------------
// inbound dispatch
// ---------------------------------------------------------------------------

function handleLine(rawLine) {
  const text = String(rawLine ?? '').trim()
  if (!text) return
  recordInbound(text)

  let message
  try {
    message = JSON.parse(text)
  } catch (err) {
    writeStderr(`fake-acp: ignoring non-JSON stdin line: ${err.message}`)
    return
  }

  if (Array.isArray(message)) {
    for (const item of message) handleMessage(item)
    return
  }
  handleMessage(message)
}

function handleMessage(message) {
  if (!isObject(message)) return
  const hasId = message.id !== undefined && message.id !== null

  if (typeof message.method === 'string') {
    // Client notifications (notifications/initialized, session/cancel, ...) carry
    // no id and need no reply.
    if (!hasId) return
    dispatchRequest(message.id, message.method, message.params)
    return
  }

  if (!hasId) return
  // Response to a request WE issued (session/request_permission).
  const resolver = pendingAgentRequests.get(message.id)
  if (!resolver) return
  pendingAgentRequests.delete(message.id)
  resolver(message.error !== undefined ? { error: message.error } : { result: message.result })
}

/** Prompts are serialised: one turn at a time, but the read loop never blocks. */
let turnChain = Promise.resolve()

function enqueueTurn(id, params) {
  turnChain = turnChain
    .then(() => runTurn(id, params))
    .catch((err) => {
      writeStderr(`fake-acp: prompt handler failed: ${err?.stack ?? err}`)
      sendError(id, -32603, 'Internal error', String(err?.message ?? err))
    })
}

function dispatchRequest(id, method, params) {
  switch (method) {
    case 'initialize':
      handleInitialize(id, params)
      return
    case 'session/new':
      handleSessionNew(id, params)
      return
    case 'session/load':
      handleSessionNew(id, params, { reuseId: true })
      return
    case 'session/set_model':
      handleSetModel(id, params)
      return
    case 'session/prompt':
      enqueueTurn(id, params)
      return
    default:
      sendError(id, -32601, 'Method not found')
  }
}

// ---------------------------------------------------------------------------
// startup / shutdown
// ---------------------------------------------------------------------------

if (typeof scenario.stderrNoise === 'string' && scenario.stderrNoise) writeStderr(scenario.stderrNoise)

process.on('uncaughtException', (err) => {
  writeStderr(`fake-acp: uncaught exception: ${err?.stack ?? err}`)
  void flushAndExit(1)
})
process.on('unhandledRejection', (err) => {
  writeStderr(`fake-acp: unhandled rejection: ${err?.stack ?? err}`)
})

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(signal, () => {
    void flushAndExit(0)
  })
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on('line', handleLine)
rl.on('close', () => {
  void flushAndExit(0)
})
process.stdin.on('error', () => {
  void flushAndExit(0)
})
