// Tests for the request translation: what a client sends in, what CodeBuddy is
// given, and what the client gets back. No CLI process is started.

import { test } from "node:test"
import assert from "node:assert/strict"

import {
  UnsupportedContent,
  canonicalBody,
  contentText,
  conversationKey,
  documentText,
  estimateInputTokens,
  estimateTextTokens,
  historyKey,
  historyExtends,
  imagePart,
  isBridgeThinkingSignature,
  normalizeTools,
  renderHistory,
  splitRequest,
  systemText,
  thinkingSignature,
  toolResultText,
  turnParts,
  usageBlock,
  validateBody,
} from "../translate.mjs"
import { decidePermission, requestedEffort } from "../index.mjs"
import { mcpInputSchema, mcpToolName, toolResult } from "../mcp-bridge.mjs"

// ---- system prompt and history layout ------------------------------------

test("leading system messages fold into the system field", () => {
  const body = canonicalBody({
    system: "be brief",
    messages: [
      { role: "system", content: "you are a helper" },
      { role: "user", content: "hi" },
    ],
  })
  assert.equal(body.system, "be brief\n\nyou are a helper")
  assert.deepEqual(body.messages, [{ role: "user", content: "hi" }])
})

test("system and developer instructions after the turn stay in the system prompt", () => {
  const body = {
    system: "base",
    messages: [
      { role: "developer", content: "first developer" },
      { role: "user", content: "hi" },
      { role: "system", content: [{ type: "text", text: "late system" }] },
      { role: "developer", content: [{ type: "text", text: "final developer" }] },
    ],
  }
  assert.doesNotThrow(() => validateBody(body))
  const canonical = canonicalBody(body)
  assert.equal(canonical.system, "base\n\nfirst developer\n\nlate system\n\nfinal developer")
  assert.deepEqual(canonical.messages, [{ role: "user", content: "hi" }])
  assert.equal(splitRequest(canonical).turn.content, "hi", "the last user is still the turn")
})

test("a non-text instruction is refused rather than silently dropped", () => {
  for (const role of ["system", "developer"]) {
    assert.throws(
      () => validateBody({ messages: [{ role: "user", content: "hi" }, { role, content: [{ type: "image" }] }] }),
      UnsupportedContent,
    )
  }
})

test("validateBody refuses a request with no conversational turn after folding instructions", () => {
  assert.throws(
    () => validateBody({ messages: [{ role: "developer", content: "rules" }] }),
    /last message is not from the user/,
  )
})

test("a body with no leading system messages is returned unchanged", () => {
  const body = { system: "s", messages: [{ role: "user", content: "hi" }] }
  assert.equal(canonicalBody(body), body)
})

test("systemText reads a string and a text-block array", () => {
  assert.equal(systemText({ system: "abc" }), "abc")
  assert.equal(systemText({ system: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }), "ab")
  assert.equal(systemText({}), "")
})

test("contentText joins the text blocks of a message", () => {
  assert.equal(contentText([{ type: "text", text: "x" }, { type: "image" }, { type: "text", text: "y" }]), "xy")
  assert.equal(contentText("plain"), "plain")
})

// ---- validation ----------------------------------------------------------

test("validateBody accepts a normal request", () => {
  assert.doesNotThrow(() =>
    validateBody({ messages: [{ role: "user", content: "hi" }] }),
  )
})

test("validateBody refuses a request with no messages", () => {
  assert.throws(() => validateBody({ messages: [] }), UnsupportedContent)
  assert.throws(() => validateBody({}), UnsupportedContent)
})

test("validateBody refuses a request that does not end on the user", () => {
  assert.throws(
    () =>
      validateBody({
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: [{ type: "text", text: "hello" }] },
        ],
      }),
    /last message is not from the user/,
  )
})

test("validateBody refuses an unknown content block type", () => {
  assert.throws(
    () => validateBody({ messages: [{ role: "user", content: [{ type: "mystery" }] }] }),
    /content block of type/,
  )
})

test("a refusal is a 400 with a readable message", () => {
  try {
    validateBody({ messages: [] })
    assert.fail("should have thrown")
  } catch (error) {
    assert.equal(error.statusCode, 400)
    assert.match(error.message, /does not support/)
  }
})

// ---- images and documents ------------------------------------------------

test("an inline base64 image becomes an ACP image part", () => {
  const data = Buffer.from("not really a png").toString("base64")
  const part = imagePart({ type: "image", source: { type: "base64", media_type: "image/png", data } })
  assert.deepEqual(part, { type: "image", data, mimeType: "image/png" })
})

test("a URL image is refused rather than fetched", () => {
  assert.throws(() => imagePart({ type: "image", source: { type: "url", url: "https://x/y.png" } }), UnsupportedContent)
})

test("an unsupported image media type is refused", () => {
  const data = Buffer.from("x").toString("base64")
  assert.throws(() => imagePart({ type: "image", source: { type: "base64", media_type: "image/bmp", data } }), /media type/)
})

test("a text document is passed through as text", () => {
  assert.equal(documentText({ type: "document", source: { type: "text", data: "hello" } }), "hello")
  const b64 = Buffer.from("from a file").toString("base64")
  assert.equal(documentText({ type: "document", source: { type: "base64", media_type: "text/plain", data: b64 } }), "from a file")
})

test("a binary document is refused", () => {
  assert.throws(
    () => documentText({ type: "document", source: { type: "base64", media_type: "application/pdf", data: "AAAA" } }),
    UnsupportedContent,
  )
})

// ---- tool results --------------------------------------------------------

test("a tool result's text is collected from its content", () => {
  assert.equal(toolResultText({ content: "plain" }), "plain")
  assert.equal(
    toolResultText({ content: [{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }] }),
    "a[image returned by a tool]b",
  )
})

// ---- history rendering ---------------------------------------------------

test("history renders both roles with tool calls and results", () => {
  const rendered = renderHistory([
    { role: "user", content: "what is the weather" },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Let me check." },
        { type: "tool_use", id: "t1", name: "get_weather", input: { city: "Paris" } },
      ],
    },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "18C" }] },
  ])
  assert.match(rendered, /User: what is the weather/)
  assert.match(rendered, /Assistant: Let me check\./)
  assert.match(rendered, /called the tool get_weather/)
  assert.match(rendered, /result of the tool call t1/)
  assert.match(rendered, /18C/)
})

test("thinking blocks stay out of the replayed history", () => {
  const rendered = renderHistory([
    { role: "user", content: "hi" },
    { role: "assistant", content: [{ type: "thinking", thinking: "secret reasoning" }, { type: "text", text: "hello" }] },
  ])
  assert.ok(!rendered.includes("secret reasoning"))
  assert.match(rendered, /hello/)
})

test("history is trimmed from the oldest end and says so", () => {
  const many = []
  for (let index = 0; index < 40; index++) {
    many.push({ role: index % 2 ? "assistant" : "user", content: `message number ${index} ${"x".repeat(2000)}` })
  }
  const rendered = renderHistory(many, 10_000)
  assert.ok(rendered.length < 12_000, "should stay near the budget")
  assert.match(rendered, /earlier conversation omitted/)
  // The newest message must survive the trim.
  assert.match(rendered, /message number 39/)
})

test("an empty history renders as nothing", () => {
  assert.equal(renderHistory([]), "")
})

// ---- this turn -----------------------------------------------------------

test("the turn's text and images become prompt parts", () => {
  const data = Buffer.from("x").toString("base64")
  const parts = turnParts({
    role: "user",
    content: [{ type: "text", text: "look at " }, { type: "image", source: { type: "base64", media_type: "image/png", data } }, { type: "text", text: "this" }],
  })
  assert.equal(parts.length, 3)
  assert.deepEqual(parts[0], { type: "text", text: "look at " })
  assert.equal(parts[1].type, "image")
  assert.deepEqual(parts[2], { type: "text", text: "this" })
})

test("adjacent text blocks are merged into one part", () => {
  const parts = turnParts({
    role: "user",
    content: [{ type: "text", text: "a" }, { type: "text", text: "b" }],
  })
  assert.deepEqual(parts, [{ type: "text", text: "ab" }])
})

test("a plain string message becomes one text part", () => {
  assert.deepEqual(turnParts({ role: "user", content: "hello" }), [{ type: "text", text: "hello" }])
})

test("splitRequest separates history from the trailing user turn", () => {
  const { history, turn } = splitRequest({
    messages: [
      { role: "user", content: "one" },
      { role: "assistant", content: "two" },
      { role: "user", content: "three" },
    ],
  })
  assert.equal(history.length, 2)
  assert.equal(turn.content, "three")
})

test("splitRequest treats a trailing tool result as the turn", () => {
  const { history, turn } = splitRequest({
    messages: [
      { role: "user", content: "one" },
      { role: "assistant", content: [{ type: "tool_use", id: "t", name: "x", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "done" }] },
    ],
  })
  assert.equal(history.length, 2)
  assert.equal(turn.content[0].type, "tool_result")
})

// ---- conversation identity ----------------------------------------------

test("the same conversation keeps one key as turns are added", () => {
  const first = {
    system: "be brief",
    messages: [{ role: "user", content: "hello" }],
  }
  const second = {
    system: "be brief",
    messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "again" },
    ],
  }
  assert.equal(conversationKey(first), conversationKey(second))
})

test("a different system prompt is a different conversation", () => {
  const a = { system: "be brief", messages: [{ role: "user", content: "hello" }] }
  const b = { system: "be verbose", messages: [{ role: "user", content: "hello" }] }
  assert.notEqual(conversationKey(a), conversationKey(b))
})

test("a different opening message is a different conversation", () => {
  const a = { messages: [{ role: "user", content: "hello" }] }
  const b = { messages: [{ role: "user", content: "goodbye" }] }
  assert.notEqual(conversationKey(a), conversationKey(b))
})

test("historyKey changes when the client rewrote its history", () => {
  const base = {
    messages: [
      { role: "user", content: "one" },
      { role: "assistant", content: "two" },
      { role: "user", content: "three" },
    ],
  }
  const rewritten = {
    messages: [
      { role: "user", content: "one" },
      { role: "assistant", content: "DIFFERENT" },
      { role: "user", content: "three" },
    ],
  }
  assert.notEqual(historyKey(base), historyKey(rewritten))
  assert.equal(historyKey(base), historyKey(structuredClone(base)))
})

test("history matching tolerates wire representations but detects assistant and tool edits", () => {
  const previous = [{ role: "user", content: "one" }, { role: "assistant", content: [
    { type: "thinking", thinking: "private", signature: "old" },
    { type: "text", text: "hello" }, { type: "text", text: " world" },
    { type: "tool_use", id: "t", name: "read", input: { a: 1, b: 2 } },
  ] }]
  const incoming = [{ role: "user", content: [{ type: "text", text: "one", cache_control: { type: "ephemeral" } }] },
    { role: "assistant", content: [{ type: "text", text: "hello world" },
      { type: "tool_use", name: "read", id: "t", input: { b: 2, a: 1 } }] }]
  assert.ok(historyExtends(incoming, previous))
  const rewritten = structuredClone(incoming)
  rewritten[1].content[0].text = "different"
  assert.equal(historyExtends(rewritten, previous), false)
  rewritten[1].content[0].text = "hello world"
  rewritten[1].content[1].input.a = 9
  assert.equal(historyExtends(rewritten, previous), false)
  assert.ok(historyExtends([{ role: "assistant", content: "answer" }], [{ role: "assistant", content: [{ type: "text", text: "answer" }] }]))
  const withLead = structuredClone(previous)
  withLead[1].content.unshift({ type: "text", text: " " })
  assert.ok(historyExtends(incoming, withLead), "clients can omit the transport-only block")
  assert.ok(historyExtends(withLead, withLead), "clients can retain the transport-only block")
  const mergedLead = structuredClone(incoming)
  mergedLead[1].content[0].text = " hello world"
  assert.ok(historyExtends(mergedLead, withLead), "clients can merge the space with the answer")
  mergedLead[1].content[0].text = " changed"
  assert.equal(historyExtends(mergedLead, withLead), false, "the lead must not hide an edited answer")
  assert.equal(historyExtends([{ role: "assistant", content: "answer" }],
    [{ role: "assistant", content: " answer" }]), false, "real answer whitespace is not a transport lead")
})

// ---- tools ---------------------------------------------------------------

test("tools are passed through with their schemas", () => {
  const tools = normalizeTools({
    tools: [{ name: "a", description: "does a", input_schema: { type: "object", properties: { x: { type: "string" } } } }],
  })
  assert.equal(tools.length, 1)
  assert.equal(tools[0].name, "a")
  assert.deepEqual(tools[0].inputSchema.properties.x, { type: "string" })
})

test("tool_choice none hides every tool", () => {
  assert.deepEqual(normalizeTools({ tools: [{ name: "a" }], tool_choice: { type: "none" } }), [])
  assert.deepEqual(normalizeTools({ tools: [{ name: "a" }], tool_choice: "none" }), [])
})

test("tool_choice naming one tool keeps only that tool", () => {
  const tools = normalizeTools({
    tools: [{ name: "a" }, { name: "b" }],
    tool_choice: { type: "tool", name: "b" },
  })
  assert.deepEqual(tools.map((tool) => tool.name), ["b"])
})

test("a duplicate tool name is refused", () => {
  assert.throws(() => normalizeTools({ tools: [{ name: "a" }, { name: "a" }] }), /duplicate tool/)
})

test("tool_choice naming an undeclared tool is refused", () => {
  assert.throws(
    () => normalizeTools({ tools: [{ name: "a" }], tool_choice: { type: "tool", name: "zzz" } }),
    /undeclared tool/,
  )
})

test("a request with no tools yields none", () => {
  assert.deepEqual(normalizeTools({}), [])
  assert.deepEqual(normalizeTools({ tools: [] }), [])
})

// ---- MCP naming ----------------------------------------------------------

test("an MCP tool name is made safe and bounded", () => {
  assert.equal(mcpToolName("get_weather"), "get_weather")
  assert.equal(mcpToolName("a.b c/d"), "a_b_c_d")
  assert.equal(mcpToolName("x".repeat(200)).length, 64)
  assert.equal(mcpToolName(""), "tool")
})

test("an MCP input schema is always an object schema", () => {
  assert.deepEqual(mcpInputSchema(undefined), { type: "object", properties: {}, additionalProperties: true })
  assert.deepEqual(mcpInputSchema({ type: "string" }), { type: "object", properties: {}, additionalProperties: true })
  const object = mcpInputSchema({ type: "object", properties: { a: {} }, required: ["a"] })
  assert.deepEqual(object.required, ["a"])
  // A malformed required is dropped rather than sent on.
  assert.equal(mcpInputSchema({ type: "object", properties: {}, required: "nope" }).required, undefined)
})

test("a tool result is sent as text, or passed through when it is content", () => {
  assert.deepEqual(toolResult("hello"), { content: [{ type: "text", text: "hello" }] })
  assert.deepEqual(toolResult({ a: 1 }), { content: [{ type: "text", text: '{"a":1}' }] })
  assert.deepEqual(
    toolResult({ content: [{ type: "text", text: "x" }], isError: true }),
    { content: [{ type: "text", text: "x" }], isError: true },
  )
})

// ---- usage ---------------------------------------------------------------

test("usage reports the session's own token counts", () => {
  const usage = usageBlock({ input: 100, output: 20, cacheRead: 30 }, 999, { output: 20, thinking: 5 })
  assert.equal(usage.input_tokens, 70)
  assert.equal(usage.output_tokens, 20)
  assert.equal(usage.cache_read_input_tokens, 30)
  assert.deepEqual(usage.output_tokens_details, { thinking_tokens: 5 })
})

test("usage falls back to an estimate when the CLI reported nothing", () => {
  const usage = usageBlock({ input: 0, output: 0 }, 500, { output: 12, thinking: 0 })
  assert.equal(usage.input_tokens, 500)
  assert.equal(usage.output_tokens, 12)
})

test("a token estimate is positive and grows with the text", () => {
  assert.ok(estimateTextTokens("") === 0)
  assert.ok(estimateTextTokens("hello world") > 0)
  assert.ok(estimateTextTokens("a".repeat(400)) > estimateTextTokens("a".repeat(40)))
  assert.ok(estimateInputTokens({ messages: [{ role: "user", content: "hi" }] }) >= 1)
})

// ---- thinking signatures -------------------------------------------------

test("a thinking signature is issued and recognisable", () => {
  const signature = thinkingSignature("session-1", "some thinking")
  assert.ok(isBridgeThinkingSignature(signature))
  assert.equal(signature, thinkingSignature("session-1", "some thinking"))
  assert.notEqual(signature, thinkingSignature("session-2", "some thinking"))
  assert.ok(!isBridgeThinkingSignature("anthropic-real-signature"))
})

// ---- reasoning effort ----------------------------------------------------

test("the effort a picker selects is read from the request", () => {
  assert.equal(requestedEffort({ reasoning_effort: "high" }), "high")
  assert.equal(requestedEffort({ effort: "xhigh" }), "xhigh")
  assert.equal(requestedEffort({ reasoningEffort: "medium" }), "medium")
  assert.equal(requestedEffort({ reasoning_effort: "HIGH" }), "high")
  assert.equal(requestedEffort({ thinking: { type: "adaptive" }, output_config: { effort: "high" } }), "high")
  assert.equal(requestedEffort({ reasoning: { effort: "max" } }), "max")
  assert.equal(requestedEffort({ reasoning_effort: "low", output_config: { effort: "high" } }), "high")
})

test("a thinking budget becomes the closest level", () => {
  assert.equal(requestedEffort({ thinking: { type: "enabled", budget_tokens: 1024 } }), "low")
  assert.equal(requestedEffort({ thinking: { type: "enabled", budget_tokens: 4096 } }), "low")
  assert.equal(requestedEffort({ thinking: { type: "enabled", budget_tokens: 7168 } }), "medium")
  assert.equal(requestedEffort({ thinking: { type: "enabled", budget_tokens: 12000 } }), "medium")
  assert.equal(requestedEffort({ thinking: { type: "enabled", budget_tokens: 16384 } }), "high")
  assert.equal(requestedEffort({ thinking: { type: "enabled", budget_tokens: 24000 } }), "high")
  assert.equal(requestedEffort({ thinking: { type: "enabled", budget_tokens: 32000 } }), "xhigh")
})

test("no effort is read from a request that names none", () => {
  assert.equal(requestedEffort({}), "")
  assert.equal(requestedEffort({ thinking: { type: "disabled" } }), "")
  assert.equal(requestedEffort({ reasoning_effort: "turbo" }), "")
  assert.equal(requestedEffort(undefined), "")
})

// ---- permission policy ---------------------------------------------------

const options = [
  { kind: "allow_always", optionId: "allow_always" },
  { kind: "allow_once", optionId: "allow" },
  { kind: "reject_once", optionId: "reject" },
]

test("the bridge's own MCP tool is allowed", () => {
  const decision = decidePermission({
    options,
    toolCall: { rawInput: { toolName: "mcp__client-tools__get_weather" } },
  })
  assert.equal(decision, "allow")
})

test("CodeBuddy's own tools are refused with its reject option", () => {
  const decision = decidePermission({
    options,
    toolCall: { rawInput: { command: "rm -rf /" }, _meta: { "codebuddy.ai/toolName": "Bash" } },
  })
  assert.equal(decision, "reject")
})

test("native tools may be allowed when explicitly asked for", () => {
  const decision = decidePermission(
    { options, toolCall: { rawInput: { command: "ls" }, _meta: { "codebuddy.ai/toolName": "Bash" } } },
    { allowNative: true },
  )
  assert.equal(decision, "allow")
})

test("a permanent grant is never chosen when a one-shot grant exists", () => {
  const decision = decidePermission({
    options,
    toolCall: { rawInput: { toolName: "mcp__client-tools__x" } },
  })
  assert.notEqual(decision, "allow_always")
})

test("a request with no usable option yields nothing to select", () => {
  assert.equal(decidePermission({ options: [], toolCall: {} }), null)
})
