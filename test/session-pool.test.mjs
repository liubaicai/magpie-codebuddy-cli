import { test } from "node:test"
import assert from "node:assert/strict"
import { SessionPool, poolLimits } from "../session-pool.mjs"

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

function fixture(maxProcs = 2) {
  const pool = new SessionPool({ env: {
    CODEBUDDY_BRIDGE_MAX_PROCS: String(maxProcs),
    CODEBUDDY_BRIDGE_IDLE_MS: "100",
  } })
  const counts = { starts: 0, live: 0, peak: 0, stops: 0 }
  function factory({ start, stop } = {}) {
    const started = deferred()
    const stopping = deferred()
    let session
    return {
      started: started.promise,
      stopping: stopping.promise,
      get session() { return session },
      async run() {
        counts.starts++
        counts.live++
        counts.peak = Math.max(counts.peak, counts.live)
        started.resolve()
        if (start) await start.promise
        session = {
          alive: true,
          busy: false,
          async stop() {
            counts.stops++
            stopping.resolve()
            if (stop) await stop.promise
            session.alive = false
            counts.live--
          },
        }
        return session
      },
    }
  }
  return { pool, counts, factory }
}

const acquire = (pool, convKey, factory, extra = {}) => pool.acquire({
  convKey, history: [], factory: factory.run, ...extra,
})
const unavailable = (error) => error.statusCode === 503

test("spare mismatch and history/force replacements finish stopping before startup", async (t) => {
  const { pool, counts, factory } = fixture(2)
  t.after(() => pool.close())
  const stopped = deferred()
  const spare = factory({ stop: stopped })
  await pool.prewarm(spare.run, "other-model")
  const replacement = factory()
  const history = [{ role: "user", content: "first" }]
  const rewrittenHistory = [{ role: "user", content: "rewritten" }]
  const request = acquire(pool, "a", replacement, { spareKey: "model", history })
  await spare.stopping
  assert.equal(counts.starts, 1, "a mismatched spare must be reaped even with another free slot")
  stopped.resolve()
  const first = await request
  assert.equal(first.session, replacement.session)
  assert.equal(counts.live, 1)
  first.session.busy = false
  assert.equal((await acquire(pool, "a", factory(), { history: [...history, { role: "assistant", content: "next" }] })).reused, true)

  first.session.busy = false
  const rewritten = factory()
  assert.equal((await acquire(pool, "a", rewritten, { history: rewrittenHistory })).session, rewritten.session)
  assert.equal(first.session.alive, false)
  rewritten.session.busy = false
  const forced = factory()
  const result = await acquire(pool, "a", forced, { history: rewrittenHistory, forceNew: true })
  assert.equal(result.reused, false)
  assert.equal(rewritten.session.alive, false)
  assert.equal(counts.peak, 1)
})

test("busy and incomplete turns survive acquire races, idle sweep and capacity eviction", async (t) => {
  const { pool, counts, factory } = fixture(1)
  t.after(() => pool.close())
  const current = (await acquire(pool, "a", factory())).session
  const unused = factory()
  for (const incomplete of [false, true]) {
    current.busy = !incomplete
    current.turn = incomplete ? { finished: false } : undefined
    current.lastUsedAt = 0
    await pool.sweep()
    await assert.rejects(acquire(pool, "a", unused, { forceNew: true }), unavailable)
    await assert.rejects(acquire(pool, "b", unused), unavailable)
    assert.equal(pool.peek("a"), current)
    assert.equal(counts.stops, 0)
  }
  assert.equal(counts.starts, 1)
  current.turn.finished = true
  current.busy = false
  const next = await acquire(pool, "b", unused)
  assert.equal(next.session, unused.session)
  assert.equal(current.alive, false)
  assert.equal(counts.peak, 1)
})

test("concurrent conversations and pending prewarm share startup capacity", async (t) => {
  const { pool, counts, factory } = fixture(2)
  t.after(() => pool.close())
  const ready = deferred()
  const warm = factory({ start: ready })
  const warming = pool.prewarm(warm.run, "key")
  await warm.started
  const gate = deferred()
  const fresh = factory({ start: gate })
  const first = acquire(pool, "a", fresh, { spareKey: "key" })
  await fresh.started
  assert.equal(counts.starts, 2, "independent startups must overlap")
  await assert.rejects(acquire(pool, "b", factory(), { spareKey: "key" }), unavailable)
  assert.equal(pool.prewarm(factory().run, "key"), warming)
  const sameConversation = assert.rejects(acquire(pool, "a", factory()), unavailable)
  gate.resolve()
  await Promise.all([first, sameConversation])
  ready.resolve()
  await warming
  assert.equal(counts.peak, 2)
  const unused = factory()
  const fromSpare = await acquire(pool, "b", unused, { spareKey: "key" })
  assert.equal(fromSpare.session, warm.session)
  assert.equal(counts.starts, 2)
  await pool.close()
  assert.equal(counts.live, 0)
})

test("spare idle TTL is enforced by sweep and by take", async (t) => {
  const { pool, counts, factory } = fixture(1)
  t.after(() => pool.close())
  const swept = factory()
  await pool.prewarm(swept.run, "key")
  swept.session.lastUsedAt = 0
  await pool.sweep()
  assert.equal(swept.session.alive, false)
  const expired = factory()
  await pool.prewarm(expired.run, "key")
  expired.session.lastUsedAt = 0
  const replacement = factory()
  const taken = await acquire(pool, "a", replacement, { spareKey: "key" })
  assert.equal(taken.session, replacement.session)
  assert.equal(expired.session.alive, false)
  assert.equal(counts.peak, 1)
  assert.deepEqual(poolLimits({}), { maxProcs: 8, idleMs: 600_000 })
})

test("close waits for in-flight acquire and prewarm factories and reaps every result", async () => {
  const { pool, counts, factory } = fixture(2)
  const gate = deferred()
  const reap = deferred()
  const warm = factory({ start: gate, stop: reap })
  const fresh = factory({ start: gate, stop: reap })
  const warming = pool.prewarm(warm.run)
  const request = acquire(pool, "a", fresh)
  const rejected = assert.rejects(request, /shutting down/)
  await Promise.all([warm.started, fresh.started])
  let closed = false
  const closing = pool.close().then(() => { closed = true })
  assert.equal(pool.close(), pool.close(), "repeated close calls join shutdown")
  await Promise.resolve()
  assert.equal(closed, false)
  gate.resolve()
  await Promise.all([warm.stopping, fresh.stopping])
  assert.equal(closed, false, "shutdown also waits for process reaping")
  reap.resolve()
  await Promise.all([closing, warming, rejected])
  assert.equal(counts.live, 0)
  assert.equal(counts.stops, 2)
  assert.equal(pool.size, 0)
  assert.deepEqual(pool.sessions(), [])
  await assert.rejects(acquire(pool, "b", factory()), /shutting down/)
})
