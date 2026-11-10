// Anthropic Messages ⇄ CodeBuddy ACP.
//
// A Magpie provider is handed Anthropic Messages requests and must answer with
// Anthropic SSE. CodeBuddy ACP takes one prompt of content blocks and streams
// updates back. This file is the translation between the two, and the rules
// about what a request may contain.

import { createHash, createHmac, randomBytes } from "node:crypto"

// ---- errors --------------------------------------------------------------

export class UnsupportedContent extends Error {
  constructor(what) {
    super(`this provider does not support ${what}`)
    this.name = "UnsupportedContent"
    this.statusCode = 400
  }
}

// ---- small helpers -------------------------------------------------------

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value)
export const text = (value) => (typeof value === "string" ? value : "")

const MESSAGES_ROLES = new Set(["user", "assistant", "system", "developer"])
const ASSISTANT_BLOCK_TYPES = new Set(["text", "thinking", "redacted_thinking", "tool_use", "tool_result"])

// ---- request normalisation ----------------------------------------------

const isInstruction = (message) => message?.role === "system" || message?.role === "developer"

function instructionText(message) {
  const content = message.content
  if (typeof content !== "string" && (!Array.isArray(content) || content.some((block) =>
    typeof block !== "string" && (block?.type !== "text" || typeof block.text !== "string")))) {
    throw new UnsupportedContent(`a non-text ${message.role} message`)
  }
  return contentText(content)
}

/**
 * ACP has one system prompt. Preserve system/developer instructions wherever
 * they occur, in message order after the top-level system field, rather than
 * replaying them as user history or dropping instructions after the last user.
 */
export function canonicalBody(body) {
  const messages = body?.messages
  if (!Array.isArray(messages)) return body
  const instructions = messages.filter(isInstruction)
  if (!instructions.length) return body
  const parts = [systemText(body), ...instructions.map(instructionText)]
  return { ...body, system: parts.filter((part) => part.trim()).join("\n\n"),
    messages: messages.filter((message) => !isInstruction(message)) }
}

export function systemText(body) {
  const system = body?.system
  if (typeof system === "string") return system
  if (Array.isArray(system)) {
    return system
      .map((block) => {
        if (typeof block === "string") return block
        if (block?.type === "text") return text(block.text)
        if (block?.type === "text_delta") return text(block.text)
        return ""
      })
      .join("")
  }
  return ""
}

export function contentText(content) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((block) => {
      if (typeof block === "string") return block
      if (block?.type === "text") return text(block.text)
      return ""
    })
    .join("")
}

/** Reject what this bridge cannot faithfully send, with a 400 the client shows. */
export function validateBody(body) {
  if (!isObject(body)) throw new UnsupportedContent("a request that is not an object")
  if (!Array.isArray(body.messages) || !body.messages.length) {
    throw new UnsupportedContent("a request without messages")
  }
  if (body.system !== undefined && typeof body.system !== "string") {
    if (!Array.isArray(body.system) || body.system.some((block) => block?.type !== "text")) {
      throw new UnsupportedContent("a non-text system prompt")
    }
  }
  for (const message of body.messages) {
    if (!isObject(message) || !MESSAGES_ROLES.has(message.role)) {
      throw new UnsupportedContent(`a message with role ${JSON.stringify(message?.role)}`)
    }
    if (isInstruction(message)) instructionText(message)
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (typeof block === "string") continue
        if (block?.type && ASSISTANT_BLOCK_TYPES.has(block.type)) continue
        throw new UnsupportedContent(`an assistant content block of type ${JSON.stringify(block?.type)}`)
      }
    }
    if (message.role === "user" && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (typeof block === "string") continue
        const type = block?.type
        if (type === "text" || type === "image" || type === "document" || type === "tool_result") continue
        throw new UnsupportedContent(`a content block of type ${JSON.stringify(type)}`)
      }
    }
  }
  const last = body.messages.filter((message) => !isInstruction(message)).at(-1)
  if (last?.role !== "user") {
    throw new UnsupportedContent(
      "a request whose last message is not from the user; continue an assistant turn from the client side instead",
    )
  }
}

// ---- prompt parts --------------------------------------------------------

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"])

/** An Anthropic image block as the ACP image part CodeBuddy takes. */
export function imagePart(block) {
  const source = block?.source
  if (source?.type !== "base64") {
    throw new UnsupportedContent("an image source other than inline base64 data")
  }
  if (!IMAGE_TYPES.has(source.media_type)) {
    throw new UnsupportedContent("an image media type other than PNG, JPEG, GIF or WebP")
  }
  const data = text(source.data)
  if (!data || data.length % 4 !== 0 || /[^A-Za-z0-9+/]/.test(data.replace(/={1,2}$/, ""))) {
    throw new UnsupportedContent("invalid base64 image data")
  }
  return { type: "image", data, mimeType: source.media_type }
}

/** A document block reduced to its text, since ACP has no document part. */
export function documentText(block) {
  const source = block?.source
  if (source?.type === "text") return text(source.data)
  if (source?.type === "base64") {
    const media = text(source.media_type)
    if (media === "text/plain" || media === "text/markdown") {
      try {
        return Buffer.from(text(source.data), "base64").toString("utf8")
      } catch {
        throw new UnsupportedContent("a document whose base64 data is not text")
      }
    }
    throw new UnsupportedContent(`a document of media type ${JSON.stringify(media)}`)
  }
  throw new UnsupportedContent("a document source other than text or base64 text")
}

/** A tool result's text, for the replayed-history form. */
export function toolResultText(block) {
  const content = block?.content
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((part) => {
      if (typeof part === "string") return part
      if (part?.type === "text") return text(part.text)
      if (part?.type === "image") return "[image returned by a tool]"
      return ""
    })
    .join("")
}

// ---- history -------------------------------------------------------------

// ACP carries one prompt per turn. Anything the client sends as history has to
// be rendered into that prompt, so the model sees the conversation it expects.
// Tool calls and results become a readable transcript rather than being dropped.
const HISTORY_BLOCK_CLIP = 8 * 1024
const HISTORY_TOTAL_BUDGET = 96 * 1024
const HISTORY_OMITTED_NOTE = "[... earlier conversation omitted to fit the prompt budget ...]\n"

function clipText(value, limit) {
  const string = String(value ?? "")
  if (string.length <= limit) return string
  const head = string.slice(0, Math.floor(limit * 0.7))
  const tail = string.slice(-Math.floor(limit * 0.25))
  return `${head}\n[... ${string.length - head.length - tail.length} characters omitted ...]\n${tail}`
}

/** One assistant message as transcript lines. */
export function renderAssistantMessage(message) {
  // A client may send plain string content for a simple message; dropping it
  // would lose whole turns from the replayed transcript.
  const raw = message?.content
  if (typeof raw === "string") return raw
  const lines = []
  for (const block of Array.isArray(raw) ? raw : []) {
    if (typeof block === "string") {
      if (block) lines.push(block)
      continue
    }
    if (block?.type === "text") {
      if (text(block.text)) lines.push(text(block.text))
      continue
    }
    if (block?.type === "thinking") continue
    if (block?.type === "tool_use") {
      lines.push(`[the assistant called the tool ${text(block.name)} with ${clipText(JSON.stringify(block.input ?? {}), HISTORY_BLOCK_CLIP)}]`)
    }
  }
  return lines.join("\n")
}

/** One user message as transcript lines, with tool results kept. */
export function renderUserMessage(message) {
  const raw = message?.content
  if (typeof raw === "string") return raw
  const lines = []
  for (const block of Array.isArray(raw) ? raw : []) {
    if (typeof block === "string") {
      if (block) lines.push(block)
      continue
    }
    if (block?.type === "text") {
      if (text(block.text)) lines.push(text(block.text))
      continue
    }
    if (block?.type === "tool_result") {
      const body = clipText(toolResultText(block), HISTORY_BLOCK_CLIP)
      lines.push(`[result of the tool call ${text(block.tool_use_id)}]\n${body}\n[end of tool result]`)
      continue
    }
    if (block?.type === "image") lines.push("[an image was attached]")
    if (block?.type === "document") lines.push(`[a document was attached]\n${clipText(documentText(block), HISTORY_BLOCK_CLIP)}`)
  }
  return lines.join("\n")
}

/**
 * The conversation before this turn, as one transcript. Trimmed from the oldest
 * end so the prompt stays inside a predictable budget.
 */
export function renderHistory(messages, budget = HISTORY_TOTAL_BUDGET) {
  const blocks = []
  for (const message of messages ?? []) {
    const rendered = message.role === "assistant" ? renderAssistantMessage(message) : renderUserMessage(message)
    if (!rendered.trim()) continue
    blocks.push({ role: message.role, text: rendered })
  }
  if (!blocks.length) return ""
  const kept = []
  let used = 0
  let omitted = false
  for (let index = blocks.length - 1; index >= 0; index--) {
    const block = blocks[index]
    const size = block.text.length + block.role.length + 8
    if (used + size > budget) {
      omitted = true
      break
    }
    used += size
    kept.unshift(block)
  }
  const body = kept
    .map((block) => `${block.role === "assistant" ? "Assistant" : "User"}: ${block.text}`)
    .join("\n\n")
  return (omitted ? HISTORY_OMITTED_NOTE : "") + body
}

/** The last user message, as the ACP prompt parts of this turn. */
export function turnParts(message) {
  const parts = []
  const pushText = (value) => {
    if (!value) return
    const last = parts.at(-1)
    if (last?.type === "text") last.text += value
    else parts.push({ type: "text", text: value })
  }
  const content = message?.content
  if (typeof content === "string") {
    pushText(content)
    return parts
  }
  for (const block of Array.isArray(content) ? content : []) {
    if (typeof block === "string") {
      pushText(block)
      continue
    }
    if (block?.type === "text") {
      pushText(text(block.text))
      continue
    }
    if (block?.type === "image") {
      parts.push(imagePart(block))
      continue
    }
    if (block?.type === "document") {
      pushText(documentText(block))
      continue
    }
    if (block?.type === "tool_result") {
      // A tool result at the tail is a turn the client is continuing; the
      // bridge sends it as its own prompt rather than as history.
      const body = toolResultText(block)
      pushText(`[result of the tool call ${text(block.tool_use_id)}]\n${body}\n[end of tool result]`)
    }
  }
  return parts
}

/**
 * Split a request into the conversation so far and this turn.
 *
 * `history` is everything before the last user message; `turn` is that message.
 */
export function splitRequest(body) {
  const messages = body.messages ?? []
  let index = messages.length - 1
  while (index > 0 && messages[index]?.role !== "user") index--
  const history = messages.slice(0, index)
  const turn = messages[index]
  return { history, turn }
}

// ---- conversation identity ----------------------------------------------

/**
 * A key for the conversation a request belongs to, so successive turns reuse
 * one CodeBuddy session instead of replaying the whole history each time.
 *
 * This is the client's conversation identity. The caller additionally scopes it
 * by account, model, effort and tool configuration before consulting the pool.
 * The system prompt and the first user message identify a conversation, and a
 * client's own session id is used when given.
 */
export function conversationKey(body) {
  const canonical = canonicalBody(body)
  const { history, turn } = splitRequest(canonical)
  const identity = [
    text(body?.metadata?.user_id) || text(body?.metadata?.session_id),
    createHash("sha256").update(String(systemText(canonical).replace(/\s+/g, ""))).digest("hex"),
    createHash("sha256").update(String(renderUserMessage(history[0] ?? turn)).replace(/\s+/g, "")).digest("hex"),
  ].join("\n")
  return createHash("sha256").update(identity).digest("hex")
}

/**
 * A key that changes when the client rewrote the history it already sent.
 *
 * A conversation's history grows every turn, so comparing the whole history
 * would never match. What is compared is the part the session was last left with:
 * the session records the history it was given, and the next request must extend
 * it rather than differ from it.
 */
export function historyKey(body) {
  const canonical = canonicalBody(body)
  const { history } = splitRequest(canonical)
  return createHash("sha256").update(JSON.stringify(history)).digest("hex")
}

/**
 * Whether `history` is the history `previous` describes plus more at the end.
 *
 * The session was left at `previous`; a client continuing the conversation sends
 * that same prefix plus its new turn. A client that rewrote an earlier message
 * sends a different prefix, and the session must not be reused.
 */
// A transport-only text block releases Magpie's pre-answer thinking hold.
// Keep it ordinary whitespace so clients can hide it without showing a label.
export const STREAM_THINKING_LEAD = " "

function hasThinkingLead(message) {
  const blocks = message?.content
  return message?.role === "assistant" && Array.isArray(blocks) && blocks.length > 1 &&
    blocks[0]?.type === "text" && blocks[0].text === STREAM_THINKING_LEAD
}

// Gateways may turn strings into text blocks, merge adjacent text deltas, omit
// thinking/signatures or the transport lead, or reorder JSON object keys. Those
// are representation changes; actual assistant text and tool inputs must agree.
function comparableContent(content, assistant = false) {
  const blocks = typeof content === "string" ? [{ type: "text", text: content }] : content
  if (!Array.isArray(blocks)) return blocks
  const out = []
  for (const raw of blocks) {
    const block = typeof raw === "string" ? { type: "text", text: raw } : raw
    if (!block || (assistant && ["thinking", "redacted_thinking"].includes(block.type))) continue
    if (block.type === "text") {
      if (!block.text) continue
      const last = out.at(-1)
      if (last?.type === "text") last.text += block.text
      else out.push({ type: "text", text: block.text })
    } else if (block.type === "tool_use") {
      out.push({ type: block.type, id: block.id, name: block.name, input: block.input ?? {} })
    } else if (block.type === "tool_result") {
      out.push({ type: block.type, tool_use_id: block.tool_use_id, is_error: Boolean(block.is_error),
        content: comparableContent(block.content) })
    } else {
      const { cache_control, ...rest } = block
      out.push(rest)
    }
  }
  return out
}

function stableJson(value) {
  return JSON.stringify(value, (_key, item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item
    return Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]]))
  })
}

export function historyExtends(history, previous) {
  if (!Array.isArray(previous)) return true
  if (!Array.isArray(history) || history.length < previous.length) return false
  const comparable = (message) => ({ role: message?.role,
    content: comparableContent(hasThinkingLead(message) ? message.content.slice(1) : message?.content,
      message?.role === "assistant") })
  for (let index = 0; index < previous.length; index++) {
    const actual = comparable(history[index])
    const expected = comparable(previous[index])
    if (stableJson(actual) === stableJson(expected)) continue
    // Some clients merge the hidden lead with the answer after omitting thought
    // blocks. Accept exactly that one extra character, only for a known lead.
    const first = actual.content?.[0]
    if (!hasThinkingLead(previous[index]) || first?.type !== "text" || typeof first.text !== "string" ||
        !first.text.startsWith(STREAM_THINKING_LEAD)) return false
    first.text = first.text.slice(STREAM_THINKING_LEAD.length)
    if (!first.text) actual.content.shift()
    if (stableJson(actual) !== stableJson(expected)) return false
  }
  return true
}

// ---- thinking signatures -------------------------------------------------

// Anthropic clients keep a thinking block only when it carries a signature, and
// send it back on later turns. CodeBuddy's thought chunks carry none, so the
// bridge issues its own: an HMAC over the session and text. It is not an
// Anthropic signature and is never validated upstream; CodeBuddy keeps its own
// context, so nothing depends on the client's copy.
const THINKING_KEY = randomBytes(32)
const THINKING_PREFIX = "cbc1."

export function thinkingSignature(sessionId, thinking) {
  return (
    THINKING_PREFIX +
    createHmac("sha256", THINKING_KEY).update(`${sessionId}\n${thinking}`).digest("base64url")
  )
}

export function isBridgeThinkingSignature(signature) {
  return typeof signature === "string" && signature.startsWith(THINKING_PREFIX)
}

// ---- token estimates -----------------------------------------------------

/** A rough token count, used only where the CLI reports none. */
export function estimateTextTokens(value) {
  const string = String(value ?? "")
  if (!string) return 0
  let ascii = 0
  let other = 0
  for (const char of string) {
    if (char.charCodeAt(0) < 128) ascii++
    else other++
  }
  return Math.ceil(ascii / 4) + other
}

/** What a request's input is worth, for a usage report the CLI did not give. */
export function estimateInputTokens(body) {
  const canonical = canonicalBody(body)
  let total = estimateTextTokens(systemText(canonical))
  for (const message of canonical.messages ?? []) {
    if (typeof message.content === "string") {
      total += estimateTextTokens(message.content)
      continue
    }
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (typeof block === "string") total += estimateTextTokens(block)
      else if (block?.type === "text") total += estimateTextTokens(block.text)
      else if (block?.type === "thinking") total += estimateTextTokens(block.thinking)
      else if (block?.type === "tool_use") total += estimateTextTokens(JSON.stringify(block.input ?? {}))
      else if (block?.type === "tool_result") total += estimateTextTokens(toolResultText(block))
      else if (block?.type === "image") total += 1500
    }
  }
  for (const tool of Array.isArray(body.tools) ? body.tools : []) {
    total += estimateTextTokens(tool?.name) + estimateTextTokens(tool?.description) + estimateTextTokens(JSON.stringify(tool?.input_schema ?? {}))
  }
  return Math.max(1, total)
}

// ---- tools ---------------------------------------------------------------

/**
 * The client's tools as the bridge's MCP tool list. A schema is passed through
 * as it is: CodeBuddy hands it to the model unchanged.
 */
export function normalizeTools(body) {
  if (!Array.isArray(body?.tools) || !body.tools.length) return []
  const choice = body.tool_choice
  if (choice === "none" || choice?.type === "none") return []
  const selected = choice?.type === "tool" ? choice.name : null
  const seen = new Set()
  const tools = []
  for (const tool of body.tools) {
    if (!isObject(tool) || typeof tool.name !== "string" || !tool.name) {
      throw new UnsupportedContent("a tool without a valid name")
    }
    if (seen.has(tool.name)) throw new UnsupportedContent(`a duplicate tool name ${JSON.stringify(tool.name)}`)
    seen.add(tool.name)
    if (selected && tool.name !== selected) continue
    const schema = tool.input_schema ?? { type: "object", properties: {} }
    if (!isObject(schema)) throw new UnsupportedContent(`an invalid schema for the tool ${tool.name}`)
    tools.push({
      name: tool.name,
      description: typeof tool.description === "string" ? tool.description : "",
      inputSchema: schema,
    })
  }
  if (selected && !tools.length) {
    throw new UnsupportedContent(`a tool_choice naming the undeclared tool ${JSON.stringify(selected)}`)
  }
  return tools
}

// ---- usage ---------------------------------------------------------------

/**
 * The usage block for one response, from the session's accumulated counts.
 *
 * CodeBuddy reports prompt/completion tokens per internal model call. A turn
 * that ran tools made several, so the first response of a turn reports the
 * totals once and later responses report what they added.
 */
export function usageBlock(sessionUsage, fallbackInput = 0, emitted = { output: 0, thinking: 0 }) {
  const input = Math.max(0, sessionUsage?.input ?? 0)
  const output = Math.max(0, sessionUsage?.output ?? 0)
  const cacheRead = Math.min(input, Math.max(0, sessionUsage?.cacheRead ?? 0))
  const thinking = Math.max(0, Math.min(output, emitted.thinking ?? 0))
  if (input === 0 && output === 0) {
    return {
      input_tokens: Math.max(0, fallbackInput),
      output_tokens: Math.max(0, emitted.output ?? 0),
      ...(thinking > 0 ? { output_tokens_details: { thinking_tokens: thinking } } : {}),
    }
  }
  return {
    input_tokens: input - cacheRead,
    output_tokens: output,
    cache_read_input_tokens: cacheRead,
    ...(thinking > 0 ? { output_tokens_details: { thinking_tokens: thinking } } : {}),
  }
}

export { HISTORY_TOTAL_BUDGET, HISTORY_OMITTED_NOTE }
