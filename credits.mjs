// Read-only CodeBuddy CN credit meter, using the credential Magpie scoped to
// this account. No CLI process, generation, sign-in refresh or global login read.
import { tokenIdentity, validToken } from './accounts.mjs'

const ENDPOINT = 'https://www.codebuddy.cn/v2/billing/meter/get-user-resource'
const PAGE_SIZE = 100
const MAX_PAGES = 5
const MAX_BYTES = 1024 * 1024
const USER_AGENT = 'CLI/2.63.2 CodeBuddy/2.63.2'
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const amount = value => {
  if (typeof value !== 'number' && !(typeof value === 'string' && value.trim())) return undefined
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 && n <= Number.MAX_SAFE_INTEGER ? n : undefined
}
const firstAmount = (row, keys) => {
  for (const key of keys) {
    if (row[key] === undefined) continue
    // A present but invalid precise field must not fall back to rounded data.
    return amount(row[key])
  }
}
const round = value => Number(value.toFixed(8))
const display = value => new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value)
const chinaTime = date => new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
}).format(date)

async function json(response) {
  if (!response.body) throw new Error('empty response')
  const reader = response.body.getReader()
  const chunks = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_BYTES) throw new Error('response too large')
      chunks.push(value)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export async function creditUsage(token, { uid, fetch: fetcher = globalThis.fetch, now = Date.now() } = {}) {
  const identity = tokenIdentity(token)
  const base = { ...(identity.name ? { user: identity.name } : {}), signIn: 'kept' }
  const fail = error => ({ ...base, error })
  const access = validToken(token)
  const userId = uid || identity.uid
  if (!access) return fail('未配置 CodeBuddy 账号授权。')
  if (typeof userId !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(userId)) {
    return fail('此授权缺少账号标识，请重新授权后查询积分。')
  }
  const signal = AbortSignal.timeout(15000)
  const from = chinaTime(new Date(now))
  const to = chinaTime(new Date(now + 100 * 366 * 86400000))
  const seen = new Set()
  let total = 0, remaining = 0, count = 0, expected
  let runsOutAt = 0
  try {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const response = await fetcher(ENDPOINT, {
        method: 'POST', redirect: 'error', signal,
        headers: { Authorization: `Bearer ${access}`, 'X-User-Id': userId,
          'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': USER_AGENT },
        body: JSON.stringify({ PageNumber: page, PageSize: PAGE_SIZE, ProductCode: 'p_tcaca', Status: [0, 3],
          PackageEndTimeRangeBegin: from, PackageEndTimeRangeEnd: to }),
      })
      if (response.status === 401 || response.status === 403) return fail('CodeBuddy 拒绝了此账号的积分查询，请重新授权。')
      if (!response.ok || response.redirected || (response.url && response.url !== ENDPOINT)) {
        return fail(`CodeBuddy 积分查询失败（HTTP ${response.status}）。`)
      }
      const payload = await json(response)
      if (!object(payload)) return fail('CodeBuddy 积分响应格式未知。')
      if (payload.code !== undefined && ![0, 200].includes(Number(payload.code))) {
        return fail('CodeBuddy 未返回成功的积分查询结果。')
      }
      const data = payload.data ?? payload
      const result = data?.Response ?? data
      const body = result?.Data ?? result
      if (result?.Error) return fail('CodeBuddy 积分接口返回错误。')
      const rows = body?.Accounts
      if (!Array.isArray(rows) || rows.length > PAGE_SIZE) return fail('CodeBuddy 积分资源格式未知。')
      if (body.TotalCount !== undefined) {
        const n = amount(body.TotalCount)
        if (!Number.isSafeInteger(n) || (expected !== undefined && n !== expected)) return fail('积分资源分页总数变化，请刷新重试。')
        expected = n
      }
      for (const row of rows) {
        if (!object(row) || row.Unlimited === true || row.unlimited === true) return fail('积分资源包含不支持的额度。')
        for (const key of ['CapacityUnit', 'OriginUnit', 'unit', 'Unit']) {
          if (row[key] !== undefined && row[key] !== 'credits' && row[key] !== '积分') return fail('积分资源单位未知，未混合统计。')
        }
        // A resource ID is unique across pages; never deduplicate by package code.
        const key = typeof row.ResourceId === 'string' && row.ResourceId ? row.ResourceId : JSON.stringify(row)
        if (seen.has(key)) return fail('积分分页重复，未返回不完整余额。')
        const size = firstAmount(row, ['CycleCapacitySizePrecise', 'CycleCapacitySize', 'CapacitySizePrecise', 'CapacitySize'])
        const left = firstAmount(row, ['CycleCapacityRemainPrecise', 'CycleCapacityRemain', 'CapacityRemainPrecise', 'CapacityRemain'])
        if (size === undefined || left === undefined || left > size) return fail('积分数值缺失或无效，未使用估算值。')
        const start = Number(row.DeductionStartTime)
        const end = Number(row.DeductionEndTime)
        // Some depleted packages are still returned by the server's Status filter.
        // Keep pagination counts, but do not include expired/future packages.
        if ((!Number.isFinite(start) || start <= now) && (!Number.isFinite(end) || end > now)) {
          total += size
          remaining += left
          if (!Number.isFinite(total) || total > Number.MAX_SAFE_INTEGER) return fail('积分数值超出安全范围。')
          if (left > 0 && end > now && (!runsOutAt || end < runsOutAt)) runsOutAt = end
        }
        count++
      }
      for (const row of rows) seen.add(typeof row.ResourceId === 'string' && row.ResourceId ? row.ResourceId : JSON.stringify(row))
      if (expected !== undefined && count > expected) return fail('积分资源数量与分页总数不一致。')
      const complete = expected !== undefined ? count === expected : rows.length < PAGE_SIZE
      if (complete) {
        // An explicitly empty meter has no known grant: do not tell routing that
        // this account is exhausted simply because no resources were returned.
        if (!count) return fail('未返回个人积分资源，余额未知。')
        total = round(total)
        remaining = round(remaining)
        const used = round(Math.max(0, total - remaining))
        const window = { name: '积分', used: total > 0 ? 100 * used / total : 100,
          amount: used, limit: total, unit: 'credits',
          display: `剩余 ${display(remaining)} / ${display(total)} 点`,
          ...(runsOutAt ? { runsOutAt: new Date(runsOutAt).toISOString() } : {}),
        }
        return { ...base, windows: [window] }
      }
      if (rows.length < PAGE_SIZE) return fail('积分分页提前结束，余额未知。')
    }
    return fail('积分分页超过查询上限，未返回不完整余额。')
  } catch {
    return fail('积分查询失败或超时，请检查网络后刷新。')
  }
}
