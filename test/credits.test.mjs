import { test } from 'node:test'
import assert from 'node:assert/strict'
import { creditUsage } from '../credits.mjs'
import { CodeBuddyCliPlugin } from '../index.mjs'

const now = Date.parse('2026-11-10T12:00:00Z')
const token = name => `e30.${Buffer.from(JSON.stringify({ sub: name, nickname: name })).toString('base64url')}.sig`
const grant = (size, left, extra = {}) => ({ CycleCapacitySizePrecise: String(size), CycleCapacityRemainPrecise: String(left), CapacityUnit: 'credits', ...extra })
const response = (Accounts, TotalCount = Accounts.length) => new Response(JSON.stringify({ code: 0, data: { Response: { Data: { Accounts, TotalCount } } } }))

test('credit meter preserves precision, sums separate grants and ignores expired/future packages', async () => {
  let calls = 0
  const usage = await creditUsage(token('A'), { now, fetch: async (url, init) => {
    calls++
    assert.equal(url, 'https://www.codebuddy.cn/v2/billing/meter/get-user-resource')
    assert.equal(init.headers['X-User-Id'], 'A')
    assert.equal(init.headers.Authorization, `Bearer ${token('A')}`)
    assert.equal(init.redirect, 'error')
    const body = JSON.parse(init.body)
    assert.equal(body.PackageEndTimeRangeBegin, '2026-11-10 20:00:00')
    return response([
      grant(100, '30.74000131', { CapacityRemain: 30, ResourceId: 'one', PackageCode: 'same', DeductionEndTime: now + 86400000 }),
      grant(100, 100, { ResourceId: 'two', PackageCode: 'same' }),
      grant(50, 50, { DeductionEndTime: now - 1 }),
      grant(60, 60, { DeductionStartTime: now + 1 }),
    ])
  } })
  assert.equal(calls, 1)
  const w = usage.windows[0]
  assert.equal(w.limit, 200)
  assert.equal(w.amount, 69.25999869)
  assert.equal(w.display, '剩余 130.74 / 200 点')
  assert.equal(w.runsOutAt, '2026-11-11T12:00:00.000Z')
  assert.equal(usage.user, 'A')
})

test('all credit pages are read before publishing a balance', async () => {
  const pages = []
  const usage = await creditUsage(token('A'), { now, fetch: async (_, init) => {
    const page = JSON.parse(init.body).PageNumber
    pages.push(page)
    return response(page === 1 ? Array.from({length:100}, (_,i) => grant(10, 1, {ResourceId:`r${i}`})) : [grant(10, 2, {ResourceId:'last'})], 101)
  } })
  assert.deepEqual(pages, [1, 2])
  assert.equal(usage.windows[0].limit, 1010)
  assert.equal(usage.windows[0].amount, 908)
})

test('missing data and incomplete or repeated pages do not masquerade as zero balance', async () => {
  for (const fetch of [
    async () => response([]),
    async () => response([grant(10, 5)], 2),
    async () => response([grant(10, 11)]),
    async () => response([{CapacitySize:10}]),
    async () => response([grant(10, 1, { CapacityUnit:'tokens' })]),
    async () => response(Array.from({length:100}, (_,i)=>grant(10, 1, { ResourceId:`r${i}` })), 101),
  ]) {
    const usage = await creditUsage(token('A'), { now, fetch })
    assert.ok(usage.error)
    assert.equal(usage.windows, undefined)
  }
  const empty = await creditUsage(token('A'), { now, fetch:async()=>response([grant(100,0)]) })
  assert.equal(empty.windows[0].used, 100, 'an explicit zero remainder is valid')
})

test('authentication and transport errors retain the account and do not expose upstream content', async () => {
  for (const fetch of [
    async () => new Response('SECRET', { status:401 }),
    async () => new Response('SECRET', { status:500 }),
    async () => { throw new Error('SECRET') },
    async () => new Response(JSON.stringify({code:123, message:'SECRET'})),
  ]) {
    const usage = await creditUsage(token('A'), { now, fetch })
    assert.ok(usage.error)
    assert.equal(usage.signIn, 'kept')
    assert.doesNotMatch(JSON.stringify(usage), /SECRET/)
    assert.equal(usage.windows, undefined)
  }
})

test('concurrent account refreshes use only their own scoped credentials', async t => {
  const original = globalThis.fetch
  const seen = []
  globalThis.fetch = async (_, init) => {
    seen.push(init.headers['X-User-Id'])
    const isA = init.headers.Authorization === `Bearer ${token('A')}`
    return response([grant(100, isA ? 25 : 75)])
  }
  const hooks = await CodeBuddyCliPlugin()
  t.after(async () => { globalThis.fetch = original; await hooks.dispose() })
  const [a,b] = await Promise.all([
    hooks.auth.usage(async()=>({type:'oauth',access:token('A')})),
    hooks.auth.usage(async()=>({type:'api',key:token('B')})),
  ])
  assert.equal(a.windows[0].amount,75)
  assert.equal(b.windows[0].amount,25)
  assert.deepEqual(new Set(seen),new Set(['A','B']))
  const missing = await hooks.auth.usage(async()=>undefined)
  const failed = await hooks.auth.usage(async()=>{throw new Error('SECRET')})
  assert.ok(missing.error && failed.error)
  assert.equal(seen.length, 2, 'a broken scoped account must never fall back to machine credentials')
})
