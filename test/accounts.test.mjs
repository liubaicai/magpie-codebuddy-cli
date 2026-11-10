// Multi-account: how accounts are told apart, what a sign-in stores, and that a
// request runs under the account Magpie chose.

import { test } from "node:test"
import assert from "node:assert/strict"

import { CodeBuddySignIn, SignInError, tokenIdentity, validToken } from "../accounts.mjs"
import { accountOf } from "../index.mjs"

// A JWT-shaped token carrying the claims CodeBuddy issues.
function token(claims) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url")
  return `${encode({ alg: "RS256", typ: "JWT" })}.${encode(claims)}.signature`
}

// ---- identity ------------------------------------------------------------

test("an account is identified by its token's own claims", () => {
  const identity = tokenIdentity(
    token({ sub: "user-1", nickname: "Ann", email: "ann@example.com", exp: 1800000000 }),
  )
  assert.equal(identity.uid, "user-1")
  assert.equal(identity.name, "Ann")
  assert.equal(identity.email, "ann@example.com")
  assert.equal(identity.expires, 1800000000 * 1000)
})

test("the union id wins over sub, so one person's products are one account", () => {
  const identity = tokenIdentity(token({ sub: "cli-id", oneid_union_id: "union-9" }))
  assert.equal(identity.uid, "union-9")
})

test("a token with no nickname falls back to the email, then the id", () => {
  assert.equal(tokenIdentity(token({ sub: "s", email: "a@b.c" })).name, "a@b.c")
  assert.equal(tokenIdentity(token({ sub: "s" })).name, "s")
})

test("a token that is not a JWT has no identity but is still a token", () => {
  const empty = { uid: "", name: "", email: "", expires: 0 }
  assert.deepEqual(tokenIdentity("opaque-token-value"), empty)
  assert.deepEqual(tokenIdentity(""), empty)
  assert.equal(validToken("opaque-token-value"), "opaque-token-value")
})

test("only something token-shaped is accepted", () => {
  assert.equal(validToken(token({ sub: "a" })), token({ sub: "a" }))
  assert.equal(validToken("  padded  "), "padded")
  assert.equal(validToken(""), "")
  assert.equal(validToken("has space"), "")
  assert.equal(validToken("has\nnewline"), "")
  assert.equal(validToken(undefined), "")
  assert.equal(validToken("x".repeat(20000)), "")
})

// ---- telling accounts apart ---------------------------------------------

test("two accounts of one person are different accounts", () => {
  // Same nickname, different tokens: Magpie keeps them apart, and so does the
  // pool's key.
  const a = token({ sub: "account-a", nickname: "Same Name" })
  const b = token({ sub: "account-b", nickname: "Same Name" })
  assert.notEqual(accountOf(a).key, accountOf(b).key)
})

test("one account keeps one key across calls", () => {
  const a = token({ sub: "account-a" })
  assert.equal(accountOf(a).key, accountOf(a).key)
})

test("an account's key does not reveal its token", () => {
  const raw = token({ sub: "account-a" })
  const account = accountOf(raw)
  assert.ok(!account.key.includes(raw))
  assert.equal(account.key.length, 16)
})

test("a request with no token is its own key, never an account's", () => {
  assert.equal(accountOf(undefined).key, "cli")
  assert.equal(accountOf("").key, "cli")
  assert.notEqual(accountOf("").key, accountOf(token({ sub: "a" })).key)
})

test("an account carries what Magpie shows and when it lapses", () => {
  const account = accountOf(token({ sub: "u", nickname: "Ann", email: "ann@example.com", exp: 1800000000 }))
  assert.equal(account.uid, "u")
  assert.equal(account.name, "Ann")
  assert.equal(account.email, "ann@example.com")
  assert.equal(account.expires, 1800000000 * 1000)
})

// ---- the sign-in ---------------------------------------------------------

// A fetch that answers the three calls the flow makes.
function fakeFetch({ state = "state-abc", token: issued, failState = false, neverReady = false } = {}) {
  const calls = []
  let starts = 0
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? "GET" })
    const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } })
    if (String(url).includes("/auth/state")) {
      if (failState) return new Response("{}", { status: 500 })
      const next = starts++ ? `${state}-2` : state
      return json({ code: 0, data: { state: next, authUrl: `https://www.codebuddy.cn/login?state=${next}` } })
    }
    if (String(url).includes("/auth/token")) {
      if (neverReady) return json({ code: 0, data: {} })
      return json({ code: 0, data: { accessToken: issued } })
    }
    if (String(url).endsWith("/accounts")) {
      return json({ code: 0, data: { accounts: [{ uid: "own-uid", nickname: "Ann", email: "ann@example.com", lastLogin: true }] } })
    }
    return new Response("{}", { status: 404 })
  }
  return { fetch, calls }
}

test("a sign-in hands over the page to open", async () => {
  const issued = token({ sub: "u1", nickname: "Ann" })
  const { fetch, calls } = fakeFetch({ token: issued })
  const signIn = new CodeBuddySignIn({ fetch })
  const started = await signIn.start()
  assert.match(started.url, /^https:\/\/www\.codebuddy\.cn\/login\?state=state-abc$/)
  assert.equal(started.state, "state-abc")
  assert.ok(started.expiresIn > 0)
  assert.equal(calls[0].method, "POST")
})

test("the account's token and identity come back once the page is authorised", async () => {
  const issued = token({ sub: "u1", nickname: "FromToken", exp: 1800000000 })
  const { fetch } = fakeFetch({ token: issued })
  const signIn = new CodeBuddySignIn({ fetch })
  const started = await signIn.start()
  const got = await signIn.poll(started.state)
  assert.equal(got.token, issued)
  // CodeBuddy's account list names the account more precisely than the token.
  assert.equal(got.identity.uid, "own-uid")
  assert.equal(got.identity.name, "Ann")
  assert.equal(got.identity.email, "ann@example.com")
})

test("polling again after the sign-in finished is refused", async () => {
  const issued = token({ sub: "u1" })
  const { fetch } = fakeFetch({ token: issued })
  const signIn = new CodeBuddySignIn({ fetch })
  const started = await signIn.start()
  await signIn.poll(started.state)
  await assert.rejects(() => signIn.poll(started.state), SignInError)
})

test("starting another sign-in does not cancel the first account's flow", async () => {
  const issued = token({ sub: "u1", nickname: "Ann" })
  const { fetch } = fakeFetch({ token: issued })
  const signIn = new CodeBuddySignIn({ fetch })
  const first = await signIn.start()
  const second = await signIn.start()
  assert.notEqual(first.state, second.state)
  assert.equal((await signIn.poll(first.state)).token, issued)
  assert.equal((await signIn.poll(second.state)).token, issued)
})

test("cancel scopes to one flow, or all when no state is given", async () => {
  const { fetch } = fakeFetch({ token: token({ sub: "u1" }) })
  const signIn = new CodeBuddySignIn({ fetch })
  const first = await signIn.start()
  const second = await signIn.start()
  signIn.cancel(first.state)
  await assert.rejects(() => signIn.poll(first.state), SignInError)
  assert.ok(await signIn.poll(second.state))
  signIn.cancel()
  assert.equal(signIn.pending, false)
})

test("a sign-in that is not authorised yet reports nothing", async () => {
  const { fetch, calls } = fakeFetch({ neverReady: true })
  const signIn = new CodeBuddySignIn({ fetch })
  const started = await signIn.start()
  assert.equal(await signIn.poll(started.state), null)
  assert.ok(!calls.some((call) => call.url.endsWith("/accounts")),
    "the account list is only fetched once a token exists")
})

test("a sign-in CodeBuddy refuses says so", async () => {
  const { fetch } = fakeFetch({ failState: true })
  const signIn = new CodeBuddySignIn({ fetch })
  await assert.rejects(() => signIn.start(), SignInError)
})

test("an expired flow is refused rather than polled", async () => {
  let now = 1_000_000
  const { fetch } = fakeFetch({ token: token({ sub: "u" }) })
  const signIn = new CodeBuddySignIn({ fetch, now: () => now })
  const started = await signIn.start()
  now += started.expiresIn * 1000 + 1
  await assert.rejects(() => signIn.poll(started.state), /expired/)
})

test("a page that is not CodeBuddy's own is never opened", async () => {
  const fetch = async (url) => {
    if (String(url).includes("/auth/state")) {
      return new Response(
        JSON.stringify({ code: 0, data: { state: "s1", authUrl: "https://evil.example/login?state=s1" } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    }
    return new Response("{}", { status: 404 })
  }
  const signIn = new CodeBuddySignIn({ fetch })
  const started = await signIn.start()
  assert.match(started.url, /^https:\/\/www\.codebuddy\.cn\//)
})
