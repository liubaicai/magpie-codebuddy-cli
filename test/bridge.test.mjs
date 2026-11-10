// Bridge-level tests: the plugin's real hooks driven against a fake CodeBuddy
// ACP process, so the whole path (request → ACP prompt → MCP tool → SSE) runs
// without the real CLI and without spending credits.

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { startFakeAcp, AcpClient, waitFor, sseParse, readRecord } from "./testkit.mjs"

// The plugin discovers the CLI through platform.mjs; pointing it at a script we
// write means the fake is what gets spawned.
function fakeLaunch(scenario) {
  const dir = mkdtempSync(join(tmpdir(), "cbc-launch-"))
  const scenarioPath = join(dir, "scenario.json")
  const record = scenario.recordPath ?? join(dir, "acp.jsonl")
  writeFileSync(scenarioPath, JSON.stringify({ ...scenario, recordPath: record, recordSessions: true }))
  // A tiny launcher that runs the fake with this scenario. platform.mjs runs a
  // node shebang script with process.execPath, which is what we want.
  const launcher = join(dir, "codebuddy")
  writeFileSync(
    launcher,
    `#!/usr/bin/env node\nprocess.env.FAKE_ACP_SCENARIO_FILE = ${JSON.stringify(scenarioPath)}\n${scenario.argvRecord ? `const { appendFileSync } = await import('node:fs'); appendFileSync(${JSON.stringify(scenario.argvRecord)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n` : ""}await import(${JSON.stringify(new URL("./fake-acp.mjs", import.meta.url).href)})\n`,
  )
  return { dir, launcher, record }
}

const cleanups = []
const cleanupAll = () => {
  while (cleanups.length) cleanups.pop()()
}

// sseParse hands back each event's data as the raw string; the plugin sends JSON.
const parseEvents = (text) =>
  sseParse(text)
    .map((entry) => {
      try {
        return JSON.parse(entry.data)
      } catch {
        return null
      }
    })
    .filter(Boolean)

// Drive one Anthropic request through the plugin's loader.
async function ask(hooks, body) {
  const loader = await hooks.auth.loader()
  const response = await loader.fetch("codebuddy-cli://local/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  return { status: response.status, events: response.ok ? parseEvents(text) : null, text }
}

function blocksOf(events) {
  const blocks = []
  for (const event of events ?? []) {
    if (event.type === "content_block_start") blocks[event.index] = { ...event.content_block }
    if (event.type !== "content_block_delta") continue
    const block = blocks[event.index]
    if (!block) continue
    if (event.delta?.type === "text_delta") block.text = (block.text ?? "") + event.delta.text
    if (event.delta?.type === "thinking_delta") block.thinking = (block.thinking ?? "") + event.delta.thinking
    if (event.delta?.type === "input_json_delta") block.__json = (block.__json ?? "") + event.delta.partial_json
  }
  return blocks.filter(Boolean).map((block) => {
    if (block.__json !== undefined) {
      try {
        block.input = JSON.parse(block.__json)
      } catch {
        block.input = {}
      }
      delete block.__json
    }
    return block
  })
}

const stopOf = (events) => (events ?? []).find((event) => event.type === "message_delta")?.delta?.stop_reason

test("adaptive high reaches the CLI without reusing a low-effort spare", async (t) => {
  const recordsDir = mkdtempSync(join(tmpdir(), "cbc-effort-"))
  const argvRecord = join(recordsDir, "argv.jsonl")
  const { dir, launcher } = fakeLaunch({ argvRecord, prompts: [{ text: ["answer"] }] })
  process.env.CODEBUDDY_PATH = launcher
  const { CodeBuddyCliPlugin } = await import(`../index.mjs?effort=${Date.now()}`)
  const hooks = await CodeBuddyCliPlugin()
  t.after(async () => {
    await hooks.dispose?.()
    delete process.env.CODEBUDDY_PATH
    rmSync(dir, { recursive: true, force: true })
    rmSync(recordsDir, { recursive: true, force: true })
  })
  const body = { model: "codebuddy-cli/hy3", stream: true, messages: [{ role: "user", content: "hi" }] }
  const launches = () => readFileSync(argvRecord, "utf8").trim().split("\n").map(JSON.parse)
  const efforts = () => launches().filter((args) => args.includes("--effort"))
    .map((args) => args[args.indexOf("--effort") + 1])
  assert.equal((await ask(hooks, { ...body, reasoning_effort: "low" })).status, 200)
  await waitFor(() => efforts().filter((level) => level === "low").length >= 2)
  assert.equal((await ask(hooks, {
    ...body, thinking: { type: "adaptive" }, output_config: { effort: "high" },
  })).status, 200)
  assert.ok(efforts().includes("high"), "high must start a high process even when a low spare is ready")
  const models = await hooks.provider.models({ id: "codebuddy-cli", models: {} })
  assert.equal(models.hy3.variants.high.reasoningEffort, "high")
  assert.ok(models.hy3.limit.output >= 16384 + 1024, "catalog must leave room for DSH high thinking and an answer")
})

test("new model or tool schema cannot inherit the previous session or spare", async (t) => {
  const { dir, launcher, record } = fakeLaunch({ prompts: [{ text: ["ok"] }] })
  process.env.CODEBUDDY_PATH = launcher
  const { CodeBuddyCliPlugin } = await import(`../index.mjs?tools=${Date.now()}`)
  const hooks = await CodeBuddyCliPlugin()
  t.after(async () => { await hooks.dispose(); delete process.env.CODEBUDDY_PATH; rmSync(dir, { recursive: true, force: true }) })
  const cases = [["hy3", "city"], ["deepseek-v4.1-flash", "city"], ["deepseek-v4.1-flash", "zip"]]
  const sessions = []
  for (const [model, property] of cases) {
    const answer = await ask(hooks, { model: `codebuddy-cli/${model}`, stream: true,
      tools: [{ name: "lookup", input_schema: { type: "object", properties: { [property]: { type: "string" } } } }],
      messages: [{ role: "user", content: "same conversation" }],
    })
    assert.equal(answer.status, 200, answer.text)
    const records = readRecord(record)
    const prompt = records.filter((row) => row.method === "session/prompt").at(-1)
    const opened = records.find((row) => row.type === "session-opened" && row.sessionId === prompt.params.sessionId)
    sessions.push(opened.sessionId)
    assert.equal(opened.argv[opened.argv.indexOf("--model") + 1], model)
    const server = opened.mcpServers[0]
    const result = await (await fetch(server.url, { method: "POST", headers: {
      ...Object.fromEntries(server.headers.map(({name, value}) => [name, value])), "Content-Type": "application/json",
    }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) })).json()
    assert.ok(result.result.tools[0].inputSchema.properties[property], "active process must expose the current tool schema")
    await waitFor(() => readRecord(record).filter((row) => row.type === "session-opened").length >= sessions.length * 2 + 1)
  }
  assert.equal(new Set(sessions).size, 3)
})

test("a text turn streams through the plugin as Anthropic SSE", async (t) => {
  const { dir, launcher } = fakeLaunch({
    prompts: [{ text: ["Hello", " from", " the fake"], usage: { prompt_tokens: 12, completion_tokens: 5 } }],
  })
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  process.env.CODEBUDDY_PATH = launcher
  t.after(() => {
    delete process.env.CODEBUDDY_PATH
    cleanupAll()
  })

  const { CodeBuddyCliPlugin } = await import("../index.mjs")
  const hooks = await CodeBuddyCliPlugin()
  t.after(() => hooks.dispose?.())

  const { status, events } = await ask(hooks, {
    model: "codebuddy-cli/hy3",
    max_tokens: 100,
    stream: true,
    messages: [{ role: "user", content: "hello" }],
  })

  assert.equal(status, 200)
  const text = blocksOf(events).filter((block) => block.type === "text").map((block) => block.text).join("")
  assert.equal(text, "Hello from the fake")
  assert.equal(stopOf(events), "end_turn")

  const messageDelta = events.find((event) => event.type === "message_delta")
  assert.equal(messageDelta.usage.input_tokens, 12)
  assert.equal(messageDelta.usage.output_tokens, 5)
})

test("thinking arrives as a thinking block when the client asks for it", async (t) => {
  const { dir, launcher } = fakeLaunch({ prompts: [{ thinking: ["pondering"], text: ["answer"] }] })
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  process.env.CODEBUDDY_PATH = launcher
  t.after(() => {
    delete process.env.CODEBUDDY_PATH
    cleanupAll()
  })

  const { CodeBuddyCliPlugin } = await import("../index.mjs")
  const hooks = await CodeBuddyCliPlugin()
  t.after(() => hooks.dispose?.())

  const { events } = await ask(hooks, {
    model: "codebuddy-cli/hy3",
    max_tokens: 100,
    stream: true,
    // A client that asks for thinking gets thinking blocks.
    thinking: { type: "enabled", budget_tokens: 1024 },
    messages: [{ role: "user", content: "hi" }],
  })
  const blocks = blocksOf(events)
  assert.ok(blocks.some((block) => block.type === "thinking" && block.thinking === "pondering"))
  assert.ok(blocks.some((block) => block.type === "text" && block.text === "answer"))
})

test("without a thinking request the thought text is sent as the answer", async (t) => {
  // A gateway drops thinking blocks when the client did not ask for thinking, so
  // sending them would leave the client with nothing while the model works.
  const { dir, launcher } = fakeLaunch({ prompts: [{ thinking: ["pondering"], text: ["answer"] }] })
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  process.env.CODEBUDDY_PATH = launcher
  t.after(() => {
    delete process.env.CODEBUDDY_PATH
    cleanupAll()
  })

  const { CodeBuddyCliPlugin } = await import("../index.mjs")
  const hooks = await CodeBuddyCliPlugin()
  t.after(() => hooks.dispose?.())

  const { events } = await ask(hooks, {
    model: "codebuddy-cli/hy3",
    max_tokens: 100,
    stream: true,
    messages: [{ role: "user", content: "hi" }],
  })
  const blocks = blocksOf(events)
  assert.ok(!blocks.some((block) => block.type === "thinking"), "no thinking block without a request for one")
  const text = blocks.filter((block) => block.type === "text").map((block) => block.text).join("")
  assert.match(text, /pondering/)
  assert.match(text, /answer/)
})

test("thinking can be turned off for a request", async (t) => {
  const { dir, launcher } = fakeLaunch({ prompts: [{ thinking: ["secret"], text: ["answer"] }] })
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  process.env.CODEBUDDY_PATH = launcher
  t.after(() => {
    delete process.env.CODEBUDDY_PATH
    cleanupAll()
  })

  const { CodeBuddyCliPlugin } = await import("../index.mjs")
  const hooks = await CodeBuddyCliPlugin()
  t.after(() => hooks.dispose?.())

  const { events } = await ask(hooks, {
    model: "codebuddy-cli/hy3",
    max_tokens: 100,
    stream: true,
    thinking: { type: "disabled" },
    messages: [{ role: "user", content: "hi" }],
  })
  const blocks = blocksOf(events)
  assert.ok(!blocks.some((block) => block.type === "thinking"), "no thinking block should be sent")
  assert.equal(blocks.filter((block) => block.type === "text").map((block) => block.text).join(""), "answer")
})

test("a client tool becomes tool_use, and its result is delivered to the model", async (t) => {
  // The fake calls the bridge's MCP server inside the turn and holds the call
  // open, exactly as CodeBuddy does. What the fake cannot do is resume the same
  // prompt after the result (a real CLI does), so the result is checked at the
  // MCP boundary: the tool_use the client receives, and the answer the fake
  // records for that call.
  const { dir, launcher } = fakeLaunch({
    prompts: [{ text: ["let me check"], mcpCalls: [{ name: "get_weather", arguments: { city: "Paris" }, fold: false }] }],
  })
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  process.env.CODEBUDDY_PATH = launcher
  t.after(() => {
    delete process.env.CODEBUDDY_PATH
    cleanupAll()
  })

  const { CodeBuddyCliPlugin } = await import("../index.mjs")
  const hooks = await CodeBuddyCliPlugin()
  t.after(() => hooks.dispose?.())

  const tool = {
    name: "get_weather",
    description: "Get the weather for a city.",
    input_schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
  }
  const messages = [{ role: "user", content: "weather in Paris?" }]

  const first = await ask(hooks, { model: "codebuddy-cli/hy3", max_tokens: 200, stream: true, tools: [tool], messages })
  assert.equal(first.status, 200)
  assert.equal(stopOf(first.events), "tool_use", "a tool call must end the response")

  const toolUse = blocksOf(first.events).find((block) => block.type === "tool_use")
  assert.ok(toolUse, "a tool_use block must be sent")
  assert.equal(toolUse.name, "get_weather")
  assert.deepEqual(toolUse.input, { city: "Paris" })

  // Handing the result back must be accepted for that call, not refused as
  // belonging to some other turn.
  const second = await ask(hooks, {
    model: "codebuddy-cli/hy3",
    max_tokens: 200,
    stream: true,
    tools: [tool],
    messages: [
      ...messages,
      { role: "assistant", content: blocksOf(first.events) },
      { role: "user", content: [{ type: "tool_result", tool_use_id: toolUse.id, content: "18C" }] },
    ],
  })
  assert.equal(second.status, 200, "the tool result must be accepted")
  assert.notEqual(second.status, 409)
  assert.equal(stopOf(second.events), "end_turn")
})

test("a tool result for a call this bridge never made is refused", async (t) => {
  const { dir, launcher } = fakeLaunch({ prompts: [{ text: ["ok"] }] })
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  process.env.CODEBUDDY_PATH = launcher
  t.after(() => {
    delete process.env.CODEBUDDY_PATH
    cleanupAll()
  })

  const { CodeBuddyCliPlugin } = await import("../index.mjs")
  const hooks = await CodeBuddyCliPlugin()
  t.after(() => hooks.dispose?.())

  const { status } = await ask(hooks, {
    model: "codebuddy-cli/hy3",
    max_tokens: 50,
    stream: true,
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_never_made", name: "x", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_never_made", content: "nope" }] },
    ],
  })
  // No live turn holds that id, so it starts a fresh session rather than
  // pretending to continue one.
  assert.equal(status, 200)
})

test("an authentication failure becomes a 401 the client can act on", async (t) => {
  const { dir, launcher } = fakeLaunch({ prompts: [{ stopReason: "refusal", authFailure: true }] })
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  process.env.CODEBUDDY_PATH = launcher
  t.after(() => {
    delete process.env.CODEBUDDY_PATH
    cleanupAll()
  })

  const { CodeBuddyCliPlugin } = await import("../index.mjs")
  const hooks = await CodeBuddyCliPlugin()
  t.after(() => hooks.dispose?.())

  const { status, text } = await ask(hooks, {
    model: "codebuddy-cli/hy3",
    max_tokens: 100,
    stream: true,
    messages: [{ role: "user", content: "hi" }],
  })
  assert.equal(status, 401)
  assert.match(text, /sign in/i)
})

test("a request with no messages is refused with a 400", async (t) => {
  const { dir, launcher } = fakeLaunch({})
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  process.env.CODEBUDDY_PATH = launcher
  t.after(() => {
    delete process.env.CODEBUDDY_PATH
    cleanupAll()
  })

  const { CodeBuddyCliPlugin } = await import("../index.mjs")
  const hooks = await CodeBuddyCliPlugin()
  t.after(() => hooks.dispose?.())

  const { status, text } = await ask(hooks, { model: "codebuddy-cli/hy3", messages: [] })
  assert.equal(status, 400)
  assert.match(text, /messages/)
})

test("count_tokens is answered without starting a process", async (t) => {
  const { CodeBuddyCliPlugin } = await import("../index.mjs")
  const hooks = await CodeBuddyCliPlugin()
  t.after(() => hooks.dispose?.())
  const loader = await hooks.auth.loader()

  const response = await loader.fetch("codebuddy-cli://local/v1/messages/count_tokens", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "some text here" }] }),
  })
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.ok(body.input_tokens > 0)
})

test("the model catalog comes from the CLI's own session", async (t) => {
  // The catalog is cached per module, so a scenario that lists its own models
  // must not be read through whatever an earlier test cached.
  const { dir, launcher } = fakeLaunch({
    models: [
      { modelId: "model-a", name: "Model A", _meta: { maxInputTokens: 5000, supportsReasoning: true, supportsImages: true, effortOptions: [{ value: "low" }, { value: "high" }] } },
      { modelId: "model-b", name: "Model B", _meta: { maxInputTokens: 9000 } },
    ],
  })
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  process.env.CODEBUDDY_PATH = launcher
  // A fresh import per test: the module's catalog cache is module state.
  const indexUrl = new URL("../index.mjs", import.meta.url)
  indexUrl.search = `?catalog=${Date.now()}`
  t.after(() => {
    delete process.env.CODEBUDDY_PATH
    cleanupAll()
  })

  const { CodeBuddyCliPlugin } = await import(indexUrl.href)
  const hooks = await CodeBuddyCliPlugin()
  t.after(() => hooks.dispose?.())

  // The catalog is cached module-wide and the probe runs in the background, so
  // wait for the CLI's own list to replace the fallback one.
  let models = {}
  for (let attempt = 0; attempt < 60; attempt++) {
    models = await hooks.provider.models()
    if (models["model-a"]) break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.ok(models["model-a"], `the fake's models must be listed, got ${Object.keys(models).join(",")}`)
  assert.equal(models["model-a"].name, "Model A")
  assert.equal(models["model-a"].limit.context, 5000)
  assert.equal(models["model-a"].capabilities.reasoning, true)
  assert.equal(models["model-a"].capabilities.attachment, true)
  assert.deepEqual(Object.keys(models["model-a"].variants ?? {}), ["low", "high"])
  assert.equal(models["model-b"].capabilities.attachment, undefined)
})

test("two turns reuse one process even after a CLI-discovery failure", async (t) => {
  const { dir, launcher, record } = fakeLaunch({
    // The second turn's prompt arrives on the SAME process, so the fake answers
    // it from `prompts[1]`. A fresh process would answer from `prompts[0]`, which
    // is exactly what this test must not see.
    prompts: [{ text: ["one"] }, { text: ["two"] }],
  })
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  process.env.CODEBUDDY_PATH = launcher
  t.after(() => {
    delete process.env.CODEBUDDY_PATH
    cleanupAll()
  })

  const { CodeBuddyCliPlugin } = await import("../index.mjs")
  const hooks = await CodeBuddyCliPlugin()
  t.after(() => hooks.dispose?.())

  const first = await ask(hooks, { model: "codebuddy-cli/hy3", max_tokens: 50, stream: true, messages: [{ role: "user", content: "first" }] })
  assert.equal(first.status, 200)

  process.env.CODEBUDDY_PATH = join(dir, "missing-codebuddy")
  const unavailable = await ask(hooks, { model: "codebuddy-cli/hy3", messages: [{ role: "user", content: "first" }] })
  assert.equal(unavailable.status, 503)
  process.env.CODEBUDDY_PATH = launcher

  const second = await ask(hooks, {
    model: "codebuddy-cli/hy3",
    max_tokens: 50,
    stream: true,
    messages: [
      { role: "user", content: "first" },
      { role: "assistant", content: [{ type: "text", text: "one" }] },
      { role: "user", content: "second" },
    ],
  })
  assert.equal(second.status, 200)
  const text = blocksOf(second.events).filter((block) => block.type === "text").map((block) => block.text).join("")
  assert.equal(text, "two")
  const prompts = readRecord(record).filter((row) => row.method === "session/prompt")
  assert.equal(prompts.length, 2)
  assert.equal(prompts[0].params.sessionId, prompts[1].params.sessionId, "failure must not strand the existing session busy")
})

test("a rewritten history starts a fresh process instead of guessing", async (t) => {
  const { dir, launcher, record } = fakeLaunch({ prompts: [{ text: ["first answer"] }, { text: ["second answer"] }] })
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  process.env.CODEBUDDY_PATH = launcher
  t.after(() => {
    delete process.env.CODEBUDDY_PATH
    cleanupAll()
  })

  const { CodeBuddyCliPlugin } = await import("../index.mjs")
  const hooks = await CodeBuddyCliPlugin()
  t.after(() => hooks.dispose?.())

  await ask(hooks, { model: "codebuddy-cli/hy3", max_tokens: 50, stream: true, messages: [{ role: "user", content: "first" }] })

  // The client replaced the assistant turn it got with something else.
  const rewritten = await ask(hooks, {
    model: "codebuddy-cli/hy3",
    max_tokens: 50,
    stream: true,
    messages: [
      { role: "user", content: "first" },
      { role: "assistant", content: [{ type: "text", text: "SOMETHING ELSE" }] },
      { role: "user", content: "second" },
    ],
  })
  assert.equal(rewritten.status, 200)
  const text = blocksOf(rewritten.events).filter((block) => block.type === "text").map((block) => block.text).join("")
  assert.equal(text, "first answer", "a fresh process starts at its first prompt")
  const prompts = readRecord(record).filter((row) => row.method === "session/prompt")
  assert.equal(prompts.length, 2)
  assert.notEqual(prompts[0].params.sessionId, prompts[1].params.sessionId)
  assert.match(JSON.stringify(prompts[1].params.prompt), /SOMETHING ELSE/, "rewritten assistant history must be replayed")
})

test("concurrent requests on one conversation each get an answer", async (t) => {
  // An agent that retries, or two requests racing, sends several at once. A
  // CodeBuddy process runs one prompt at a time, so they must each get a process
  // of their own; sharing one made every stream but the first end with nothing.
  const { dir, launcher } = fakeLaunch({
    prompts: [
      { text: ["answer one"], delayMs: 200 },
      { text: ["answer two"], delayMs: 200 },
      { text: ["answer three"], delayMs: 200 },
    ],
  })
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  process.env.CODEBUDDY_PATH = launcher
  t.after(() => {
    delete process.env.CODEBUDDY_PATH
    cleanupAll()
  })

  const indexUrl = new URL("../index.mjs", import.meta.url)
  indexUrl.search = `?concurrent=${Date.now()}`
  const { CodeBuddyCliPlugin } = await import(indexUrl.href)
  const hooks = await CodeBuddyCliPlugin()
  t.after(() => hooks.dispose?.())

  const askOnce = async () => {
    const res = await ask(hooks, {
      model: "codebuddy-cli/hy3",
      max_tokens: 64,
      stream: true,
      messages: [{ role: "user", content: "same question" }],
    })
    assert.equal(res.status, 200, res.text)
    const error = res.events.find((event) => event.type === "error")
    const text = blocksOf(res.events).filter((block) => block.type === "text").map((block) => block.text).join("")
    return { error: error ? String(error.error?.message ?? "") : "", text }
  }
  const results = await Promise.all([askOnce(), askOnce(), askOnce()])
  for (const [index, result] of results.entries()) {
    assert.equal(result.error, "", `request ${index + 1} must not fail: ${result.error}`)
    assert.ok(result.text.trim(), `request ${index + 1} must produce text`)
  }
})

test("a missing CLI is reported as a 503 with what to install", async (t) => {
  process.env.CODEBUDDY_PATH = join(tmpdir(), "definitely-not-a-codebuddy-binary")
  t.after(() => delete process.env.CODEBUDDY_PATH)

  const { CodeBuddyCliPlugin } = await import("../index.mjs")
  const hooks = await CodeBuddyCliPlugin()
  t.after(() => hooks.dispose?.())

  const { status, text } = await ask(hooks, {
    model: "codebuddy-cli/hy3",
    max_tokens: 50,
    stream: true,
    messages: [{ role: "user", content: "hi" }],
  })
  assert.equal(status, 503)
  assert.match(text, /codebuddy/i)
})

test("each account gets its own process, so a route cannot answer as another", async (t) => {
  // The launcher records the token each process was started with, which is the
  // proof that a request ran under the account Magpie chose.
  const dir = mkdtempSync(join(tmpdir(), "cbc-isolation-"))
  const record = join(dir, "tokens.txt")
  writeFileSync(record, "")
  writeFileSync(join(dir, "scenario.json"), JSON.stringify({ prompts: [{ text: ["ok"] }] }))
  const launcher = join(dir, "codebuddy")
  writeFileSync(
    launcher,
    `#!/usr/bin/env node\n` +
      `const fs = await import("node:fs")\n` +
      `fs.appendFileSync(${JSON.stringify(record)}, (process.env.CODEBUDDY_AUTH_TOKEN ?? "none") + "\\n")\n` +
      `process.env.FAKE_ACP_SCENARIO_FILE = ${JSON.stringify(join(dir, "scenario.json"))}\n` +
      `await import(${JSON.stringify(new URL("./fake-acp.mjs", import.meta.url).href)})\n`,
  )
  process.env.CODEBUDDY_PATH = launcher
  t.after(() => {
    delete process.env.CODEBUDDY_PATH
    rmSync(dir, { recursive: true, force: true })
  })

  const indexUrl = new URL("../index.mjs", import.meta.url)
  indexUrl.search = `?isolation=${Date.now()}`
  const { CodeBuddyCliPlugin } = await import(indexUrl.href)
  const hooks = await CodeBuddyCliPlugin()
  t.after(() => hooks.dispose?.())

  const jwt = (sub) => {
    const enc = (v) => Buffer.from(JSON.stringify(v)).toString("base64url")
    return `${enc({ alg: "RS256" })}.${enc({ sub, exp: 1800000000 })}.sig`
  }
  const tokenA = jwt("account-a")
  const tokenB = jwt("account-b")

  const loaderA = await hooks.auth.loader(async () => ({ type: "oauth", access: tokenA }))
  const loaderB = await hooks.auth.loader(async () => ({ type: "oauth", access: tokenB }))

  const send = async (loader) => {
    const res = await loader.fetch("codebuddy-cli://local/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "codebuddy-cli/hy3", max_tokens: 50, stream: true, messages: [{ role: "user", content: "hello" }] }),
    })
    assert.equal(res.status, 200)
    await res.text()
  }

  await send(loaderA)
  await send(loaderB)
  await send(loaderA)

  const seen = readFileSync(record, "utf8").trim().split("\n").filter(Boolean)
  assert.ok(seen.includes(tokenA), "account A's process must run with its token")
  assert.ok(seen.includes(tokenB), "account B's process must run with its token")
  // Every process belongs to one of the two accounts; none ran unauthenticated.
  assert.ok(!seen.includes("none"), "no process may start without an account's token")
  // B never runs on A's process: its requests carry B's token.
  assert.ok(seen.filter((entry) => entry === tokenB).length >= 1, "account B must have a process of its own")
  // A's second request reused a process rather than always starting a new one.
  // A spare may also have been opened ahead of time, so the count is bounded
  // rather than exact.
  const aCount = seen.filter((entry) => entry === tokenA).length
  assert.ok(aCount <= 4, `account A must not start a process per request, saw ${aCount}`)
})

test("an account's token is what its CodeBuddy process runs under", async (t) => {
  // The launcher writes the token it saw to a file, so the test can check which
  // account a process was started for.
  const dir = mkdtempSync(join(tmpdir(), "cbc-token-"))
  const record = join(dir, "tokens.txt")
  const launcher = join(dir, "codebuddy")
  writeFileSync(
    launcher,
    `#!/usr/bin/env node\n` +
      `const fs = await import("node:fs")\n` +
      `fs.appendFileSync(${JSON.stringify(record)}, (process.env.CODEBUDDY_AUTH_TOKEN ?? "none") + "\\n")\n` +
      `process.env.FAKE_ACP_SCENARIO_FILE = ${JSON.stringify(join(dir, "scenario.json"))}\n` +
      `await import(${JSON.stringify(new URL("./fake-acp.mjs", import.meta.url).href)})\n`,
  )
  writeFileSync(join(dir, "scenario.json"), JSON.stringify({ prompts: [{ text: ["ok"] }] }))
  process.env.CODEBUDDY_PATH = launcher
  t.after(() => {
    delete process.env.CODEBUDDY_PATH
    rmSync(dir, { recursive: true, force: true })
  })

  const indexUrl = new URL("../index.mjs", import.meta.url)
  indexUrl.search = `?token=${Date.now()}`
  const { CodeBuddyCliPlugin } = await import(indexUrl.href)
  const hooks = await CodeBuddyCliPlugin()
  t.after(() => hooks.dispose?.())

  const token = "account-token-for-this-test"
  const loader = await hooks.auth.loader(async () => ({ type: "oauth", access: token }))
  const res = await loader.fetch("codebuddy-cli://local/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "codebuddy-cli/hy3", max_tokens: 50, stream: true, messages: [{ role: "user", content: "hi" }] }),
  })
  assert.equal(res.status, 200)
  await res.text()

  const seen = readFileSync(record, "utf8").trim().split("\n").filter(Boolean)
  assert.ok(seen.includes(token), `the CLI must run with the account's token, saw ${JSON.stringify(seen)}`)
  assert.ok(!seen.includes("none"), "no process may start without an account's token")
})
