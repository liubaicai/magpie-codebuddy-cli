/**
 * Test kit for the Magpie <-> CodeBuddy (ACP) bridge.
 *
 * Everything here is dependency-free (Node built-ins only) and hermetic:
 * `startFakeAcp()` spawns test/fake-acp.mjs, `AcpClient` speaks ACP to it, and
 * the remaining helpers cover the boring plumbing (polling, SSE parsing, JSONL
 * records).
 */

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/** Absolute path of the fake agent script. */
export const FAKE_ACP_PATH = join(HERE, 'fake-acp.mjs')

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ---------------------------------------------------------------------------
// fake agent process
// ---------------------------------------------------------------------------

/**
 * Spawn the fake ACP agent.
 *
 * @param {object} [scenario] scenario object (see test/fake-acp.mjs). When
 *   `scenario.recordPath` is set it is used verbatim, otherwise a path inside a
 *   fresh temp dir is generated so `recordPath` assertions always work.
 * @param {{ env?: Record<string,string>, cwd?: string, args?: string[] }} [options]
 * @returns {{
 *   child: import('node:child_process').ChildProcess,
 *   scenarioPath: string,
 *   recordPath: string,
 *   lines: () => any[],
 *   rawLines: () => string[],
 *   stderr: () => string,
 *   exitCode: () => number | null,
 *   closed: Promise<number | null>,
 *   cleanup: () => void,
 * }}
 */
export function startFakeAcp(scenario = {}, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fake-acp-'))
  const scenarioPath = join(dir, 'scenario.json')
  const recordPath = typeof scenario.recordPath === 'string' && scenario.recordPath
    ? scenario.recordPath
    : join(dir, 'record.jsonl')

  const payload = { ...scenario, recordPath }
  writeFileSync(scenarioPath, JSON.stringify(payload, null, 2), 'utf8')

  const env = { ...process.env, ...(options.env ?? {}) }
  // Never let an ambient inline scenario leak into a test's scenario file.
  delete env.FAKE_ACP_SCENARIO
  env.FAKE_ACP_SCENARIO_FILE = scenarioPath

  const child = spawn(process.execPath, [FAKE_ACP_PATH, ...(options.args ?? [])], {
    cwd: options.cwd ?? process.cwd(),
    env,
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  /** @type {string[]} */
  const rawLines = []
  /** @type {any[]} */
  const parsed = []
  let stderrText = ''
  let exitCode = null

  child.stdout.setEncoding('utf8')
  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity })
  rl.on('line', (line) => {
    rawLines.push(line)
    if (!line.trim()) return
    try {
      parsed.push(JSON.parse(line))
    } catch {
      parsed.push({ __unparsable: line })
    }
  })

  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    stderrText += chunk
  })

  const closed = new Promise((resolve) => {
    child.on('close', (code) => {
      exitCode = code
      resolve(code)
    })
  })

  const cleanup = () => {
    try {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    } catch {
      /* already gone */
    }
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }

  return {
    child,
    scenarioPath,
    recordPath,
    lines: () => parsed.slice(),
    rawLines: () => rawLines.slice(),
    stderr: () => stderrText,
    exitCode: () => exitCode,
    closed,
    cleanup,
  }
}

// ---------------------------------------------------------------------------
// minimal ACP client
// ---------------------------------------------------------------------------

const DEFAULTS = { rpcTimeoutMs: 15000 }

/**
 * Minimal ACP client: NDJSON framing, id -> pending map, notification/request
 * dispatch. Deliberately dumb about semantics so tests can assert raw shapes.
 */
export class AcpClient {
  /**
   * @param {import('node:child_process').ChildProcess} child process with
   *   pipe stdin/stdout (as returned by startFakeAcp()).
   * @param {{
   *   autoApprove?: boolean,
   *   rpcTimeoutMs?: number,
   *   onNotification?: (msg: any) => void,
   *   onRequest?: (msg: any) => any,
   * }} [options]
   */
  constructor(child, options = {}) {
    this.child = child
    this.options = { ...DEFAULTS, ...options }
    this.notifications = []
    this.requests = []
    this.responses = []
    this.received = []
    this.unparsable = []
    this.answeredRequests = []
    this.closed = false
    this.exitCode = null

    /** @type {Map<any, {method:string, resolve:Function, reject:Function, timer:any}>} */
    this._pending = new Map()
    this._notificationHandlers = new Set()
    this._requestHandlers = new Set()
    this._nextId = 0
    this._buffer = ''

    if (typeof options.onNotification === 'function') this.onNotification(options.onNotification)
    if (typeof options.onRequest === 'function') this.onRequest(options.onRequest)

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => this._onData(chunk))
    child.on('error', (err) => this._fail(err))
    this._exit = new Promise((resolve) => {
      child.once('close', (code) => {
        this.exitCode = code
        this._fail(new Error(`fake ACP process closed (code ${code})`))
        resolve(code)
      })
    })
  }

  // -- plumbing ------------------------------------------------------------

  _onData(chunk) {
    this._buffer += chunk
    let index
    while ((index = this._buffer.indexOf('\n')) >= 0) {
      const line = this._buffer.slice(0, index).replace(/\r$/, '')
      this._buffer = this._buffer.slice(index + 1)
      if (!line.trim()) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        this.unparsable.push(line)
        continue
      }
      this.received.push(message)
      this._dispatch(message)
    }
  }

  _dispatch(message) {
    if (message === null || typeof message !== 'object') return
    const hasId = message.id !== undefined && message.id !== null

    if (typeof message.method === 'string' && hasId) {
      this.requests.push(message)
      void this._handleRequest(message)
      return
    }
    if (typeof message.method === 'string') {
      this.notifications.push(message)
      for (const handler of this._notificationHandlers) {
        try {
          handler(message)
        } catch {
          /* a throwing assertion helper must not break framing */
        }
      }
      return
    }
    if (!hasId) return

    this.responses.push(message)
    const pending = this._pending.get(message.id)
    if (!pending) return
    this._pending.delete(message.id)
    clearTimeout(pending.timer)
    if (message.error !== undefined) {
      const err = new Error(`${pending.method}: ${message.error?.message ?? 'JSON-RPC error'}`)
      err.code = message.error?.code
      err.data = message.error?.data
      err.rpcError = message.error
      pending.reject(err)
    } else {
      pending.resolve(message.result)
    }
  }

  async _handleRequest(message) {
    let answer
    for (const handler of this._requestHandlers) {
      try {
        const result = await handler(message)
        if (result !== undefined) {
          answer = result
          break
        }
      } catch {
        /* fall through to auto-approval */
      }
    }
    if (answer === undefined && this.options.autoApprove !== false) {
      answer = autoAnswer(message)
    }
    if (answer === undefined) return // left to the test via answerRequest()
    this.answerRequest(message, answer)
  }

  _write(message) {
    if (this.closed) throw new Error('AcpClient is closed')
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  _fail(err) {
    if (this.closed) return
    this.closed = true
    for (const [id, pending] of this._pending) {
      clearTimeout(pending.timer)
      pending.reject(err)
      this._pending.delete(id)
    }
  }

  // -- public API ----------------------------------------------------------

  /**
   * Send a request and resolve with its result (rejects on JSON-RPC error).
   * @param {string} method
   * @param {any} [params]
   * @param {{ timeoutMs?: number }} [options]
   */
  rpc(method, params, options = {}) {
    const id = ++this._nextId
    const timeoutMs = options.timeoutMs ?? this.options.rpcTimeoutMs
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this._pending.delete(id)) reject(new Error(`${method}: timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this._pending.set(id, { method, resolve, reject, timer })
      try {
        this._write({ jsonrpc: '2.0', id, method, params })
      } catch (err) {
        clearTimeout(timer)
        this._pending.delete(id)
        reject(err)
      }
    })
  }

  /** Send a notification (no id, no reply). */
  notify(method, params) {
    this._write({ jsonrpc: '2.0', method, params })
  }

  /** Answer an agent -> client request. */
  answerRequest(message, result) {
    const entry = { request: message, result }
    this.answeredRequests.push(entry)
    try {
      this._write({ jsonrpc: '2.0', id: message.id, result })
    } catch {
      /* process already gone */
    }
  }

  /** Answer with a JSON-RPC error. */
  rejectRequest(message, code, text, data) {
    const error = { code, message: text }
    if (data !== undefined) error.data = data
    this.answeredRequests.push({ request: message, error })
    try {
      this._write({ jsonrpc: '2.0', id: message.id, error })
    } catch {
      /* process already gone */
    }
  }

  /**
   * Register a notification handler. Return value `undefined` means "not mine".
   * @returns {() => void} unsubscribe
   */
  onNotification(handler) {
    this._notificationHandlers.add(handler)
    return () => this._notificationHandlers.delete(handler)
  }

  /**
   * Register an agent-request handler. Return `undefined` to let another
   * handler (or auto-approval) answer it.
   * @returns {() => void} unsubscribe
   */
  onRequest(handler) {
    this._requestHandlers.add(handler)
    return () => this._requestHandlers.delete(handler)
  }

  /** All `session/update` payloads seen so far, in arrival order. */
  updates() {
    return this.notifications
      .filter((message) => message.method === 'session/update')
      .map((message) => message.params?.update)
      .filter(Boolean)
  }

  /** Convenience: notifications of one `sessionUpdate` kind. */
  updatesOf(kind) {
    return this.updates().filter((update) => update.sessionUpdate === kind)
  }

  /** Close stdin and wait for the child to exit (graceful first, then SIGTERM). */
  async close() {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return this.child.exitCode
    if (!this.closed) {
      this.closed = true
      try {
        this.child.stdin.end()
      } catch {
        /* already closed */
      }
    }
    // stdin EOF is the polite shutdown path; give it a moment before escalating.
    let code = await Promise.race([this._exit, sleep(1000).then(() => undefined)])
    if (code !== undefined) return code
    try {
      this.child.kill('SIGTERM')
    } catch {
      /* already gone */
    }
    code = await Promise.race([this._exit, sleep(2000).then(() => undefined)])
    if (code !== undefined) return code
    try {
      this.child.kill('SIGKILL')
    } catch {
      /* already gone */
    }
    return await Promise.race([this._exit, sleep(1000).then(() => null)])
  }
}

function autoAnswer(message) {
  if (message.method === 'session/request_permission') {
    const options = Array.isArray(message.params?.options) ? message.params.options : []
    const chosen =
      options.find((option) => option?.kind === 'allow_once') ??
      options.find((option) => String(option?.kind ?? '').startsWith('allow')) ??
      options[0]
    if (!chosen) return { outcome: { outcome: 'cancelled' } }
    return { outcome: { outcome: 'selected', optionId: chosen.optionId } }
  }
  // Unknown agent request: answer "method not found" so the fake never hangs.
  return undefined
}

// ---------------------------------------------------------------------------
// misc helpers
// ---------------------------------------------------------------------------

/**
 * Poll `predicate` until it returns truthy.
 * @template T
 * @param {() => T | Promise<T>} predicate
 * @param {{ timeoutMs?: number, intervalMs?: number, message?: string }} [options]
 * @returns {Promise<T>}
 */
export async function waitFor(predicate, options = {}) {
  const timeoutMs = options.timeoutMs ?? 5000
  const intervalMs = options.intervalMs ?? 20
  const deadline = Date.now() + timeoutMs
  let lastError = null
  for (;;) {
    try {
      const value = await predicate()
      if (value) return value
      lastError = null
    } catch (err) {
      lastError = err
    }
    if (Date.now() >= deadline) {
      const suffix = options.message ? ` (${options.message})` : ''
      const cause = lastError ? `; last error: ${lastError.message}` : ''
      throw new Error(`waitFor timed out after ${timeoutMs}ms${suffix}${cause}`)
    }
    await sleep(intervalMs)
  }
}

/**
 * Parse an SSE body into `[{ event, data }]` entries. Multiple `data:` lines in
 * one block are joined with "\n"; comment lines are ignored; a block without an
 * `event:` field defaults to "message".
 *
 * @param {string} text
 * @returns {Array<{ event: string, data: string }>}
 */
export function sseParse(text) {
  const blocks = String(text ?? '').split(/\r?\n\r?\n/)
  const events = []
  for (const block of blocks) {
    if (!block.trim()) continue
    let event = 'message'
    const data = []
    let sawField = false
    for (const line of block.split(/\r?\n/)) {
      if (!line || line.startsWith(':')) continue
      const colon = line.indexOf(':')
      const field = colon === -1 ? line : line.slice(0, colon)
      let value = colon === -1 ? '' : line.slice(colon + 1)
      if (value.startsWith(' ')) value = value.slice(1)
      if (field === 'event') {
        event = value
        sawField = true
      } else if (field === 'data') {
        data.push(value)
        sawField = true
      }
    }
    if (!sawField) continue
    events.push({ event, data: data.join('\n') })
  }
  return events
}

/**
 * Read a JSONL record file produced by the fake agent (`recordPath`).
 * Missing file => empty array.
 * @param {string} path
 * @returns {any[]}
 */
export function readRecord(path) {
  if (!path || !existsSync(path)) return []
  const text = readFileSync(path, 'utf8')
  const out = []
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line))
    } catch {
      out.push({ __unparsable: line })
    }
  }
  return out
}

/** Create a throwaway directory the caller is expected to remove. */
export function makeTempDir(prefix = 'magpie-test-') {
  return mkdtempSync(join(tmpdir(), prefix))
}

/** Best-effort recursive delete. */
export function removeDir(path) {
  if (!path) return
  try {
    rmSync(path, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
}
