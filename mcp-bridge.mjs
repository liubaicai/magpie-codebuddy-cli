// The client's tools, served to CodeBuddy over MCP.
//
// CodeBuddy connects to an HTTP MCP server named in session/new and calls its
// tools itself. That is the whole bridge: a tool the client declared becomes an
// MCP tool here, CodeBuddy calls it mid-turn, and the call is handed back to the
// client, which executes it and returns the result to the same turn.
//
// Verified against CodeBuddy 2.181.0: it speaks streamable HTTP, sends
// initialize / notifications/initialized / tools/list / tools/call, and honours
// a per-call progressToken. It also accepts `headers` on the server entry, which
// is how each process gets its own unguessable token.

import { createServer } from "node:http"
import { randomBytes, timingSafeEqual } from "node:crypto"

const PROTOCOL_VERSION = "2025-06-18"
const MAX_BODY_BYTES = 8 * 1024 * 1024
const TOOL_NAME_LIMIT = 64

// MCP tool names allow [A-Za-z0-9_-]; a client's tool name can be anything, so
// each is mapped to a safe name and the mapping is kept for the turn.
export function mcpToolName(name) {
  const cleaned = String(name ?? "")
    .replace(/[^A-Za-z0-9_-]/g, "_")
    .slice(0, TOOL_NAME_LIMIT)
  return cleaned || "tool"
}

// The JSON Schema CodeBuddy sees. A client's schema can contain keywords some
// models reject, and MCP requires an object schema at the top level.
export function mcpInputSchema(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return { type: "object", properties: {}, additionalProperties: true }
  }
  const out = { ...schema }
  if (out.type !== "object") {
    return { type: "object", properties: {}, additionalProperties: true }
  }
  if (!out.properties || typeof out.properties !== "object" || Array.isArray(out.properties)) {
    out.properties = {}
  }
  if (!Array.isArray(out.required)) delete out.required
  return out
}

/**
 * A single-purpose MCP server for one CodeBuddy process.
 *
 * `onCall(name, args)` is awaited and its return value becomes the tool result:
 * a string is sent as text, anything else as JSON. Throwing marks the result as
 * an error the model can read and react to.
 */
export class ToolBridge {
  #server
  #sockets = new Set()
  #token = randomBytes(24).toString("hex")
  #tools = new Map()
  #onCall
  #pending = new Set()
  #closed = false

  constructor(onCall) {
    this.#onCall = onCall
  }

  get token() {
    return this.#token
  }

  get port() {
    const address = this.#server?.address()
    return address && typeof address === "object" ? address.port : 0
  }

  get url() {
    return this.port ? `http://127.0.0.1:${this.port}/mcp` : ""
  }

  // The MCP server entry CodeBuddy is handed in session/new.
  get serverEntry() {
    return {
      name: "client-tools",
      type: "http",
      url: this.url,
      headers: [{ name: "X-Bridge-Token", value: this.#token }],
    }
  }

  /** Replace the tools offered to the model. `tools` is [{name, description, inputSchema}]. */
  setTools(tools) {
    this.#tools.clear()
    for (const tool of tools ?? []) {
      if (!tool || typeof tool.name !== "string" || !tool.name) continue
      const mapped = mcpToolName(tool.name)
      // Two client tools that map to the same MCP name would shadow each other;
      // keep the first and let the second be unreachable rather than misroute.
      if (this.#tools.has(mapped)) continue
      this.#tools.set(mapped, {
        name: mapped,
        clientName: tool.name,
        description: typeof tool.description === "string" ? tool.description : "",
        inputSchema: mcpInputSchema(tool.inputSchema),
      })
    }
  }

  async start() {
    if (this.#server) return this
    const server = createServer((req, res) => {
      this.#handle(req, res).catch(() => {
        try {
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json" })
            res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "bridge failure" }, id: null }))
          } else {
            res.end()
          }
        } catch {}
      })
    })
    server.on("connection", (socket) => {
      this.#sockets.add(socket)
      socket.on("close", () => this.#sockets.delete(socket))
    })
    server.keepAliveTimeout = 30_000
    this.#server = server
    await new Promise((resolve, reject) => {
      server.once("error", reject)
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject)
        resolve()
      })
    })
    return this
  }

  async close() {
    if (this.#closed) return
    this.#closed = true
    for (const socket of this.#sockets) {
      try {
        socket.destroy()
      } catch {}
    }
    this.#sockets.clear()
    const server = this.#server
    this.#server = null
    if (!server) return
    await new Promise((resolve) => {
      server.close(() => resolve())
      // A kept-alive socket would hold close() open; the destroy above handles
      // most, and this bounds the rest.
      const timer = setTimeout(resolve, 1000)
      timer.unref?.()
    })
  }

  #authorised(req) {
    const header = req.headers["x-bridge-token"]
    const provided = Array.isArray(header) ? header[0] : header
    if (typeof provided !== "string") return false
    const a = Buffer.from(provided)
    const b = Buffer.from(this.#token)
    return a.length === b.length && timingSafeEqual(a, b)
  }

  async #handle(req, res) {
    // Only this machine, and only with this process's token.
    const remote = req.socket.remoteAddress ?? ""
    if (remote !== "127.0.0.1" && remote !== "::1" && remote !== "::ffff:127.0.0.1") {
      res.writeHead(403)
      res.end()
      return
    }
    if (!this.#authorised(req)) {
      res.writeHead(401)
      res.end()
      return
    }
    const url = req.url ?? "/"
    if (!url.startsWith("/mcp")) {
      res.writeHead(404)
      res.end()
      return
    }
    if (req.method === "GET" || req.method === "DELETE") {
      // No server-initiated stream and no session to delete: this bridge is
      // stateless between calls.
      res.writeHead(405, { Allow: "POST" })
      res.end()
      return
    }
    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST" })
      res.end()
      return
    }

    const body = await readBody(req)
    if (body === null) {
      res.writeHead(413)
      res.end()
      return
    }
    let message
    try {
      message = JSON.parse(body)
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }))
      return
    }

    const batch = Array.isArray(message) ? message : [message]
    const replies = []
    for (const item of batch) {
      const reply = await this.#dispatch(item)
      if (reply) replies.push(reply)
    }
    if (!replies.length) {
      // Every message was a notification.
      res.writeHead(202)
      res.end()
      return
    }
    const payload = JSON.stringify(replies.length === 1 ? replies[0] : replies)
    res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) })
    res.end(payload)
  }

  async #dispatch(message) {
    if (!message || typeof message !== "object") return null
    const method = typeof message.method === "string" ? message.method : ""
    const id = message.id
    const params = message.params && typeof message.params === "object" ? message.params : {}

    // Notifications carry no id and expect no reply.
    if (id === undefined) return null

    if (method === "initialize") {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "magpie-codebuddy-cli", version: "1.0.0" },
        },
      }
    }
    if (method === "ping") return { jsonrpc: "2.0", id, result: {} }
    if (method === "tools/list") {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          tools: [...this.#tools.values()].map((tool) => ({
            name: tool.name,
            description: tool.description || tool.name,
            inputSchema: tool.inputSchema,
          })),
        },
      }
    }
    if (method === "tools/call") {
      const name = typeof params.name === "string" ? params.name : ""
      const tool = this.#tools.get(name)
      if (!tool) {
        return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true } }
      }
      const args = params.arguments && typeof params.arguments === "object" ? params.arguments : {}
      try {
        const value = await this.#onCall(tool.clientName, args, { progressToken: params._meta?.progressToken })
        return { jsonrpc: "2.0", id, result: toolResult(value) }
      } catch (error) {
        return {
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: String(error?.message ?? error) }], isError: true },
        }
      }
    }
    return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } }
  }
}

// A tool's answer as MCP content. An explicit {content, isError} is passed
// through so a caller can send images or its own error flag.
export function toolResult(value) {
  if (value && typeof value === "object" && !Array.isArray(value) && Array.isArray(value.content)) {
    return { content: value.content, ...(value.isError ? { isError: true } : {}) }
  }
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null)
  return { content: [{ type: "text", text }] }
}

function readBody(req) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    req.on("data", (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        resolve(null)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    req.on("error", () => resolve(null))
  })
}
