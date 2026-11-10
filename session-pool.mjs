// One ACP process per conversation, reused only while the incoming history
// extends its stored transcript. Live processes, spares and startup reservations
// share one capacity limit; a stopping process keeps its slot until reaped.

import { ToolBridge } from "./mcp-bridge.mjs"
import { historyExtends } from "./translate.mjs"

const DEFAULT_MAX_PROCS = 8
const DEFAULT_IDLE_MS = 10 * 60 * 1000

const positive = (value, fallback) => {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : fallback
}
const serving = (session) => Boolean(session.busy || (session.turn && !session.turn.finished))

export function poolLimits(env = process.env) {
  return {
    maxProcs: positive(env.CODEBUDDY_BRIDGE_MAX_PROCS, DEFAULT_MAX_PROCS),
    idleMs: positive(env.CODEBUDDY_BRIDGE_IDLE_MS, DEFAULT_IDLE_MS),
  }
}

export class SessionPool {
  #sessions = new Map()
  #locks = new Map()
  #limits
  #onToolCall
  #closed = false
  #closing
  #all = new Set()
  #launching = 0
  #pending = new Set()
  #stopping = new Map()
  #spare = null
  #spareKey = ""
  #sparePending
  #spareStop

  constructor({ onToolCall, env = process.env } = {}) {
    this.#onToolCall = onToolCall
    this.#limits = poolLimits(env)
  }

  get size() {
    return this.#sessions.size
  }

  /** Assigned sessions; spares and startup reservations are counted separately. */
  sessions() {
    return [...this.#sessions.values()]
  }

  get maxProcs() {
    return this.#limits.maxProcs
  }

  // Only acquisitions of the same conversation wait for one another. Store the
  // exact tail promise used for cleanup, rather than the promise it resolves to.
  async #withLock(key, fn) {
    const previous = this.#locks.get(key) ?? Promise.resolve()
    let release
    const current = new Promise((resolve) => { release = resolve })
    const tail = previous.then(() => current)
    this.#locks.set(key, tail)
    await previous
    try {
      return await fn()
    } finally {
      release()
      if (this.#locks.get(key) === tail) this.#locks.delete(key)
    }
  }

  /** Atomically claim an idle process; a racing caller gets null. */
  claim(convKey) {
    if (this.#closed) return null
    const session = this.#sessions.get(convKey)
    if (!session?.alive || serving(session)) return null
    session.busy = true
    session.lastUsedAt = Date.now()
    return session
  }

  /** Inspect a live assigned session without claiming it. */
  peek(convKey) {
    const session = this.#sessions.get(convKey)
    if (!session?.alive) return null
    session.lastUsedAt = Date.now()
    return session
  }

  async acquire({ convKey, history, factory, forceNew = false, spareKey = "" }) {
    this.#assertOpen()
    return this.#withLock(convKey, async () => {
      this.#assertOpen()
      const existing = this.#sessions.get(convKey)
      // Busy and incomplete turns belong to their original caller, even when
      // forceNew or rewritten history asks for a different process.
      if (existing && serving(existing)) throw this.#capacityError()
      if (existing?.alive && !forceNew && historyExtends(history, existing.history)) {
        existing.busy = true
        existing.lastUsedAt = Date.now()
        return { session: existing, reused: true }
      }
      if (existing) await this.#retire(convKey)
      this.#assertOpen()
      const spare = await this.#takeSpare(spareKey)
      this.#assertOpen()
      const session = spare ?? await this.#launch(factory)
      // close() can run while the factory or spare retirement is pending.
      this.#assertOpen()
      session.history = history
      session.lastUsedAt = Date.now()
      session.busy = true
      this.#sessions.set(convKey, session)
      return { session, reused: false }
    })
  }

  /** Keep at most one spare, without evicting an assigned conversation. */
  prewarm(factory, spareKey = "") {
    if (this.#closed) return Promise.resolve()
    if (this.#sparePending) return this.#sparePending
    const pending = (async () => {
      // Defer so #sparePending is installed before any work can finish.
      await Promise.resolve()
      try {
        const spare = this.#spare
        if (spare && !this.#spareExpired(spare) && this.#spareKey === spareKey) return
        if (spare) await this.#discardSpare()
        await this.#spareStop
        this.#assertOpen()
        const session = await this.#launch(factory, false)
        if (!session) return
        this.#assertOpen()
        session.lastUsedAt = Date.now()
        this.#spare = session
        this.#spareKey = spareKey
      } catch {
        // Speculative startup failure is reported only if a real request fails.
      } finally {
        this.#sparePending = undefined
      }
    })()
    this.#sparePending = pending
    return pending
  }

  #spareExpired(session) {
    return !session.alive || Date.now() - session.lastUsedAt > this.#limits.idleMs
  }

  async #takeSpare(spareKey) {
    await this.#spareStop
    const spare = this.#spare
    if (!spare) return null
    if (this.#spareExpired(spare) || this.#spareKey !== spareKey) {
      await this.#discardSpare()
      return null
    }
    this.#spare = null
    return spare
  }

  #discardSpare() {
    const spare = this.#spare
    if (!spare) return this.#spareStop
    this.#spare = null
    const stopping = this.#stop(spare)
    this.#spareStop = stopping
    void stopping.then(() => {
      if (this.#spareStop === stopping) this.#spareStop = undefined
    })
    return stopping
  }

  async awaitTurn(convKey, timeoutMs = 300_000, signal) {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if (this.#closed || signal?.aborted) return null
      const session = this.#sessions.get(convKey)
      if (!session?.alive) return null
      const claimed = this.claim(convKey)
      if (claimed) return claimed
      if (Date.now() >= deadline) return null
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 50)
        timer.unref?.()
      })
    }
  }

  #assertOpen() {
    if (this.#closed) throw new Error("the CodeBuddy bridge is shutting down")
  }

  #capacityError() {
    const error = new Error(
      `CodeBuddy has no idle process available (limit ${this.#limits.maxProcs}); raise CODEBUDDY_BRIDGE_MAX_PROCS or wait for a turn to finish`,
    )
    error.statusCode = 503
    return error
  }

  // JavaScript runs selection and reservation synchronously, with no await
  // between counting slots and reserving one. Startup itself never holds a
  // global lock. Retirements keep their #all entry until stop() has completed.
  async #reserve(evict) {
    for (;;) {
      this.#assertOpen()
      if (this.#all.size + this.#launching < this.#limits.maxProcs) {
        this.#launching++
        return true
      }
      if (!evict) return false
      if (this.#spare) {
        await this.#discardSpare()
        continue
      }
      const oldest = [...this.#sessions.entries()]
        .filter(([, session]) => !serving(session))
        .sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt)[0]
      if (!oldest) throw this.#capacityError()
      await this.#retire(oldest[0])
    }
  }

  #launch(factory, evict = true) {
    const pending = (async () => {
      if (!await this.#reserve(evict)) return null
      let reserved = true
      try {
        this.#assertOpen()
        const session = await factory()
        this.#all.add(session)
        this.#launching--
        reserved = false
        if (this.#closed) {
          await this.#stop(session)
          this.#assertOpen()
        }
        return session
      } finally {
        if (reserved) this.#launching--
      }
    })()
    this.#pending.add(pending)
    void pending.then(
      () => this.#pending.delete(pending),
      () => this.#pending.delete(pending),
    )
    return pending
  }

  #stop(session) {
    const existing = this.#stopping.get(session)
    if (existing) return existing
    const stopping = Promise.resolve().then(() => session.stop()).catch(() => {}).finally(() => {
      this.#all.delete(session)
      this.#stopping.delete(session)
    })
    this.#stopping.set(session, stopping)
    return stopping
  }

  #retire(convKey) {
    const session = this.#sessions.get(convKey)
    if (!session || serving(session)) return Promise.resolve()
    this.#sessions.delete(convKey)
    return this.#stop(session)
  }

  /** Expire idle assigned sessions and the unused spare, never running turns. */
  async sweep() {
    if (this.#closed) return
    const now = Date.now()
    const stopping = []
    for (const [key, session] of this.#sessions) {
      if (!serving(session) && (!session.alive || now - session.lastUsedAt > this.#limits.idleMs)) {
        stopping.push(this.#retire(key))
      }
    }
    if (this.#spare && this.#spareExpired(this.#spare)) stopping.push(this.#discardSpare())
    await Promise.all(stopping)
  }

  close() {
    if (this.#closing) return this.#closing
    this.#closed = true
    this.#sessions.clear()
    this.#spare = null
    this.#closing = (async () => {
      await Promise.allSettled([
        ...[...this.#all].map((session) => this.#stop(session)),
        ...this.#pending,
        this.#sparePending,
      ])
      // Pending factories stop their own results; include any retirement which
      // was already underway when shutdown began.
      await Promise.all([...this.#stopping.values()])
    })()
    return this.#closing
  }

  createToolBridge(onCall) {
    return new ToolBridge(onCall ?? this.#onToolCall)
  }
}

export { DEFAULT_MAX_PROCS, DEFAULT_IDLE_MS }
