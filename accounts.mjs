// CodeBuddy accounts: signing in, and which token a request runs under.
//
// CodeBuddy's CLI takes its account from `CODEBUDDY_AUTH_TOKEN`, so an account is
// a token here. Magpie keeps one credential per account (its own
// `plugin-auth.json`, keyed `codebuddy-cli#xxxx`) and hands the plugin the
// account a request is for; routing across accounts — smart, order, rotate and
// the rest — is Magpie's, not the plugin's. What the plugin must do is:
//
//   - sign in and describe the account well enough for Magpie to tell accounts
//     apart (an id and a name, so two accounts of one person stay separate),
//   - hand the account's own token to each request's CodeBuddy process,
//   - never let one account's process serve another's request.
//
// The sign-in is CodeBuddy's own browser flow, the one its CLI and desktop app
// use: ask for a state, open the page, poll for the token.

const CN_ORIGIN = "https://www.codebuddy.cn"
const PLUGIN_PATH = "/v2/plugin"
const FLOW_TTL_MS = 10 * 60 * 1000
const POLL_INTERVAL_S = 2
const REQUEST_TIMEOUT_MS = 15_000
const MAX_BODY = 64 * 1024

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value)
const text = (value) => (typeof value === "string" ? value : "")

class SignInError extends Error {
  constructor(message) {
    super(message)
    this.name = "SignInError"
  }
}

/**
 * What a token says about its account.
 *
 * CodeBuddy issues a JWT. Its `sub` identifies the account, and the nickname and
 * email name it. A token that is not a JWT is still usable: it simply has no
 * identity, and the account is named by Magpie's own key.
 */
export function tokenIdentity(token) {
  const raw = text(token)
  const out = { uid: "", name: "", email: "", expires: 0 }
  const parts = raw.split(".")
  if (parts.length !== 3) return out
  let claims
  try {
    claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"))
  } catch {
    return out
  }
  if (!isObject(claims)) return out
  const sub = text(claims.sub)
  // `sub` is the account id CodeBuddy uses; the union id identifies the same
  // person across its products and is the better key when both are present.
  out.uid = text(claims.oneid_union_id) || sub
  out.email = text(claims.email)
  out.name = text(claims.nickname) || text(claims.preferred_username) || out.email || sub
  const exp = Number(claims.exp)
  if (Number.isFinite(exp) && exp > 0) out.expires = Math.trunc(exp * 1000)
  return out
}

// A token must look like one before it is stored or handed to the CLI.
export function validToken(value) {
  const raw = text(value).trim()
  if (!raw || raw.length > 16384) return ""
  // CodeBuddy's tokens are JWT-ish: base64url segments and dots. Anything with
  // whitespace or control characters is not a token.
  if (/[\s\x00-\x1f\x7f]/.test(raw)) return ""
  return raw
}

async function boundedJson(response) {
  if (!response?.body) throw new SignInError("CodeBuddy returned no answer")
  const reader = response.body.getReader()
  const chunks = []
  let size = 0
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.byteLength
      if (size > MAX_BODY) throw new SignInError("CodeBuddy's answer was too large")
      chunks.push(part.value)
    }
  } finally {
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"))
  } catch {
    throw new SignInError("CodeBuddy's answer was not JSON")
  }
}

const ok = (payload) => payload?.code === 0 || payload?.code === 200

/**
 * CodeBuddy's browser sign-in.
 *
 * `start()` asks for a state and gives the page to open; `poll()` is asked again
 * until it reports the token. Both are bounded so a sign-in cannot hang Magpie's
 * dialog.
 */
export class CodeBuddySignIn {
  #fetch
  #now
  #flows = new Map()

  constructor({ fetch: fetcher = globalThis.fetch, now = Date.now } = {}) {
    this.#fetch = fetcher
    this.#now = now
  }

  get pending() {
    this.#prune()
    return this.#flows.size > 0
  }

  #prune() {
    const now = this.#now()
    for (const [state, flow] of this.#flows) if (now >= flow.expires) this.#flows.delete(state)
  }

  #request(path, init = {}) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    timer.unref?.()
    const url = CN_ORIGIN + PLUGIN_PATH + path
    return (async () => {
      try {
        const response = await this.#fetch(url, {
          ...init,
          redirect: "error",
          signal: controller.signal,
        })
        if (!response.ok) {
          throw new SignInError(
            response.status === 401 || response.status === 403
              ? "CodeBuddy refused the sign-in"
              : `CodeBuddy answered ${response.status}`,
          )
        }
        return await boundedJson(response)
      } catch (error) {
        if (error instanceof SignInError) throw error
        throw new SignInError(
          error?.name === "AbortError" ? "CodeBuddy did not answer in time" : "CodeBuddy could not be reached",
        )
      } finally {
        clearTimeout(timer)
      }
    })()
  }

  /** Begin a sign-in: returns the page to open and the flow's id. */
  async start() {
    this.#prune()
    const payload = await this.#request("/auth/state?platform=workbuddy", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: "{}",
    })
    const data = isObject(payload?.data) ? payload.data : null
    const state = text(data?.state)
    if (!ok(payload) || !state) throw new SignInError("CodeBuddy did not start a sign-in")
    // Only its own sign-in page is opened: a URL from the answer is used only
    // when it is that page.
    let url = `${CN_ORIGIN}/login?state=${encodeURIComponent(state)}`
    const offered = text(data?.authUrl) || text(data?.auth_url) || text(data?.url)
    if (offered) {
      try {
        const parsed = new URL(offered)
        if (parsed.origin === CN_ORIGIN && parsed.protocol === "https:") url = parsed.href
      } catch {
        // Keep CodeBuddy's own page.
      }
    }
    this.#flows.set(state, { expires: this.#now() + FLOW_TTL_MS })
    return { url, state, expiresIn: Math.floor(FLOW_TTL_MS / 1000), interval: POLL_INTERVAL_S }
  }

  /**
   * Ask whether the page has been authorised yet.
   *
   * Returns the account when it has, or null while it is still waiting.
   */
  async poll(state) {
    const flow = this.#flows.get(state)
    if (!flow) throw new SignInError("this sign-in is no longer active")
    if (this.#now() >= flow.expires) {
      this.#flows.delete(state)
      throw new SignInError("the sign-in expired; start it again")
    }
    this.#prune()
    const payload = await this.#request(`/auth/token?state=${encodeURIComponent(state)}`, {
      method: "GET",
      headers: { Accept: "application/json" },
    })
    if (!ok(payload)) return null
    const data = isObject(payload.data) ? payload.data : null
    const token = validToken(data?.accessToken ?? data?.access_token)
    if (!token) return null

    // The account's own name and id come from CodeBuddy, so two accounts of one
    // person are told apart by Magpie.
    let identity = tokenIdentity(token)
    try {
      const accounts = await this.#request("/accounts", {
        method: "GET",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      })
      const rows = Array.isArray(accounts?.data?.accounts) ? accounts.data.accounts.filter(isObject) : []
      const own = rows.find((row) => row.lastLogin === true) ?? rows[0]
      if (own) {
        identity = {
          ...identity,
          uid: text(own.uid) || identity.uid,
          name: text(own.nickname) || text(own.name) || identity.name,
          email: text(own.email) || identity.email,
        }
      }
    } catch {
      // The token is what matters; a name is only how Magpie shows the account.
    }
    this.#flows.delete(state)
    return { token, identity }
  }

  cancel(state) {
    if (state === undefined) this.#flows.clear()
    else this.#flows.delete(state)
  }
}

export { SignInError, CN_ORIGIN, FLOW_TTL_MS, POLL_INTERVAL_S }
