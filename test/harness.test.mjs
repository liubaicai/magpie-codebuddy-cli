/**
 * Self-tests for the fake ACP agent / test kit.
 *
 * Run with:  node --test test/harness.test.mjs
 *
 * These tests exist so the bridge tests can trust the fake: if the fake drifts
 * away from the verified codebuddy 2.181.0 shapes, this file fails first.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { join } from 'node:path'

import {
  AcpClient,
  readRecord,
  removeDir,
  sleep,
  startFakeAcp,
  sseParse,
  waitFor,
} from './testkit.mjs'

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * Start a fake + client pair and run initialize + session/new.
 * Registers cleanup on the test context.
 */
async function openSession(t, scenario = {}, clientOptions = {}, sessionParams = {}) {
  const fake = startFakeAcp(scenario)
  const client = new AcpClient(fake.child, clientOptions)
  t.after(async () => {
    await client.close()
    fake.cleanup()
  })
  const init = await client.rpc('initialize', { protocolVersion: 1, clientCapabilities: {} })
  const session = await client.rpc('session/new', {
    cwd: process.cwd(),
    mcpServers: [],
    ...sessionParams,
  })
  return { fake, client, init, session }
}

/** Text of every agent_message_chunk received, concatenated. */
function messageText(client) {
  return client
    .updatesOf('agent_message_chunk')
    .map((update) => update.content?.text ?? '')
    .join('')
}

function messageDeltas(client) {
  return client.updatesOf('agent_message_chunk').map((update) => update.content?.text ?? '')
}

// ---------------------------------------------------------------------------
// initialize
// ---------------------------------------------------------------------------

test('initialize returns protocolVersion 1 and the verified agentCapabilities', async (t) => {
  const fake = startFakeAcp({ stderrNoise: 'fake-acp: boot noise' })
  const client = new AcpClient(fake.child)
  t.after(async () => {
    await client.close()
    fake.cleanup()
  })

  const result = await client.rpc('initialize', { protocolVersion: 1, clientCapabilities: {} })

  assert.equal(result.protocolVersion, 1)
  assert.deepEqual(result.agentCapabilities.promptCapabilities, { image: true, embeddedContext: true })
  assert.deepEqual(result.agentCapabilities.mcpCapabilities, { http: true, sse: true })
  assert.equal(result.agentCapabilities.loadSession, true)
  assert.equal(result.agentCapabilities.delegateToolsSupport, true)
  assert.equal(result.agentCapabilities.mainAgentSupport, false)
  assert.equal(result.agentCapabilities.multitaskSupport, true)
  assert.equal(result.agentCapabilities.toolModeSupport, false)
  assert.equal(result.agentCapabilities.codeModeSupport, false)
  assert.equal(result.agentCapabilities.metaPromptSupport, true)

  assert.deepEqual(result.authMethods, [
    { id: 'external', name: 'Login with Google/Github', description: null },
  ])

  // stderr noise must never pollute the protocol stream
  assert.ok(fake.stderr().includes('boot noise'))
  assert.equal(client.unparsable.length, 0)
})

test('unknown method with an id returns JSON-RPC -32601', async (t) => {
  const fake = startFakeAcp({})
  const client = new AcpClient(fake.child)
  t.after(async () => {
    await client.close()
    fake.cleanup()
  })
  await client.rpc('initialize', { protocolVersion: 1, clientCapabilities: {} })

  await assert.rejects(client.rpc('session/nope', {}), (err) => {
    assert.equal(err.code, -32601)
    assert.equal(err.rpcError.message, 'Method not found')
    return true
  })
})

// ---------------------------------------------------------------------------
// session/new
// ---------------------------------------------------------------------------

test('session/new returns a sessionId, scenario models, modes and configOptions', async (t) => {
  const { session } = await openSession(t, {})

  assert.match(session.sessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)

  assert.equal(session.models.currentModelId, 'hy3')
  assert.deepEqual(
    session.models.availableModels.map((model) => model.modelId),
    ['hy3', 'deepseek-v4.1-flash'],
  )
  const flash = session.models.availableModels[1]
  assert.equal(flash.name, 'DeepSeek-V4.1-Flash')
  assert.equal(flash._meta.maxInputTokens, 1000000)
  assert.deepEqual(flash._meta.effortOptions, [
    { value: 'low', name: 'Low' },
    { value: 'high', name: 'High' },
  ])

  assert.deepEqual(
    session.modes.availableModes.map((mode) => mode.id),
    ['default', 'acceptEdits', 'plan'],
  )
  assert.equal(session.configOptions[0].id, 'mode')
  assert.equal(session.configOptions[0].currentValue, 'default')
  assert.equal(session.configOptions[1].currentValue, 'hy3')
  assert.equal(session.multitaskOn, false)
})

test('scenario can override models, currentModelId and supportsImages', async (t) => {
  const { session } = await openSession(t, {
    currentModelId: 'tiny',
    supportsImages: false,
    models: [
      { modelId: 'tiny', name: 'Tiny', description: 'free', _meta: { supportsImages: true, maxInputTokens: 1024 } },
    ],
  })

  assert.equal(session.models.currentModelId, 'tiny')
  assert.equal(session.models.availableModels.length, 1)
  assert.equal(session.models.availableModels[0]._meta.supportsImages, false)
  assert.equal(session.models.availableModels[0]._meta.maxInputTokens, 1024)
})

test('config_option_update notification arrives before the session/new response', async (t) => {
  const fake = startFakeAcp({})
  const client = new AcpClient(fake.child)
  t.after(async () => {
    await client.close()
    fake.cleanup()
  })
  await client.rpc('initialize', { protocolVersion: 1, clientCapabilities: {} })
  const beforeNew = client.received.length
  const session = await client.rpc('session/new', { cwd: process.cwd(), mcpServers: [] })

  // Ordering on the wire: notification first, response afterwards.
  const methods = client.received
    .slice(beforeNew)
    .map((message) => (typeof message.method === 'string' ? message.method : `response:${message.id}`))
  const notificationIndex = methods.indexOf('session/update')
  const responseIndex = methods.findIndex((entry) => entry.startsWith('response:'))
  assert.ok(notificationIndex >= 0, 'expected a session/update notification')
  assert.ok(responseIndex > notificationIndex, 'notification must precede the response')

  const configUpdate = client
    .updatesOf('config_option_update')
    .find((update) => Array.isArray(update.configOptions))
  assert.ok(configUpdate, 'expected config_option_update with configOptions')
  assert.ok(configUpdate.configOptions.some((option) => option.id === 'model'))

  // ...and it already carries the session id the response is about to return.
  const notification = client.notifications.find((message) => message.method === 'session/update')
  assert.equal(notification.params.sessionId, session.sessionId)
})

// ---------------------------------------------------------------------------
// session/prompt
// ---------------------------------------------------------------------------

test('a prompt streams its text deltas and ends with stopReason end_turn', async (t) => {
  const { client, session } = await openSession(t, {
    prompts: [{ text: ['Hello', ' ', 'world'], deltaDelayMs: 5 }],
  })

  const result = await client.rpc('session/prompt', {
    sessionId: session.sessionId,
    prompt: [{ type: 'text', text: 'say hi' }],
  })

  assert.equal(result.stopReason, 'end_turn')
  assert.match(result.userMessageId, /^[0-9a-f-]{36}$/i)
  assert.equal(result._meta['codebuddy.ai/outcome'], 'SUCCESS')
  assert.equal(result._meta['codebuddy.ai/finishReason'], 'stop')
  assert.equal(result._meta['codebuddy.ai/requestId'], 'r1')

  assert.deepEqual(messageDeltas(client), ['Hello', ' ', 'world'])
  assert.equal(messageText(client), 'Hello world')

  // every chunk carries the same messageId
  const ids = new Set(client.updatesOf('agent_message_chunk').map((update) => update.messageId))
  assert.equal(ids.size, 1)
})

test('prompts are consumed in order and fall back to fallbackPrompt', async (t) => {
  const { client, session } = await openSession(t, {
    prompts: [{ text: ['first'] }],
    fallbackPrompt: { text: ['fallback'] },
  })

  const one = await client.rpc('session/prompt', { sessionId: session.sessionId, prompt: [] })
  const two = await client.rpc('session/prompt', { sessionId: session.sessionId, prompt: [] })

  assert.equal(one._meta['codebuddy.ai/requestId'], 'r1')
  assert.equal(two._meta['codebuddy.ai/requestId'], 'r2')
  assert.deepEqual(messageDeltas(client), ['first', 'fallback'])
})

test('thinking chunks arrive as agent_thought_chunk', async (t) => {
  const { client, session } = await openSession(t, {
    prompts: [{ thinking: ['Let me ', 'think'], text: ['done'] }],
  })

  await client.rpc('session/prompt', { sessionId: session.sessionId, prompt: [] })

  const thoughts = client.updatesOf('agent_thought_chunk')
  assert.deepEqual(
    thoughts.map((update) => update.content.text),
    ['Let me ', 'think'],
  )
  assert.equal(new Set(thoughts.map((update) => update.messageId)).size, 1)
  assert.notEqual(thoughts[0].messageId, client.updatesOf('agent_message_chunk')[0].messageId)
})

test('tool_call + tool_call_update notifications arrive with the scenario ids', async (t) => {
  const { client, session } = await openSession(t, {
    prompts: [
      {
        text: ['ran it'],
        tools: [{ id: 'call_1', name: 'Bash', rawInput: { command: 'echo hi' }, rawOutput: 'hi', status: 'completed' }],
      },
    ],
  })

  await client.rpc('session/prompt', { sessionId: session.sessionId, prompt: [] })

  const starts = client.updatesOf('tool_call')
  assert.equal(starts.length, 1)
  assert.equal(starts[0].toolCallId, 'call_1')
  assert.equal(starts[0].title, 'Bash')
  assert.equal(starts[0].kind, 'execute')
  assert.equal(starts[0].status, 'in_progress')
  assert.deepEqual(starts[0].rawInput, { command: 'echo hi' })

  const updates = client.updatesOf('tool_call_update')
  assert.equal(updates.length, 1)
  assert.equal(updates[0].toolCallId, 'call_1')
  assert.equal(updates[0].status, 'completed')
  assert.equal(updates[0].rawOutput, 'hi')
})

test('usage_update carries the codebuddy.ai/usage meta block', async (t) => {
  const { client, session } = await openSession(t, {
    prompts: [
      {
        text: ['ok'],
        usage: { prompt_tokens: 24805, completion_tokens: 799, reasoning_tokens: 57, costAmount: 0.05 },
      },
    ],
  })

  await client.rpc('session/prompt', { sessionId: session.sessionId, prompt: [] })

  const usage = client.updatesOf('usage_update')
  assert.equal(usage.length, 1)
  // Verified probe shape: used == prompt_tokens, size == 1000000.
  assert.equal(usage[0].used, 24805)
  assert.equal(usage[0].size, 1000000)
  assert.deepEqual(usage[0].cost, { amount: 0.05, currency: '' })
  assert.deepEqual(usage[0]._meta['codebuddy.ai/usage'], {
    prompt_tokens: 24805,
    completion_tokens: 799,
    total_tokens: 25604,
    completion_tokens_details: { reasoning_tokens: 57 },
  })
})

test('noise notifications (session_info_update, available_commands_update) are ignored gracefully', async (t) => {
  const { client, session } = await openSession(t, {
    noiseNotifications: true,
    prompts: [{ text: ['ok'] }],
  })

  const result = await client.rpc('session/prompt', { sessionId: session.sessionId, prompt: [] })

  assert.equal(result.stopReason, 'end_turn')
  assert.ok(client.updatesOf('session_info_update').length >= 1)
  assert.ok(client.updatesOf('available_commands_update').length >= 1)
  assert.equal(messageText(client), 'ok')
})

// ---------------------------------------------------------------------------
// permission gating
// ---------------------------------------------------------------------------

test('a permission request is emitted and the turn only proceeds after the client answers', async (t) => {
  const { client, session } = await openSession(
    t,
    {
      prompts: [
        {
          permission: { title: 'Bash', kind: 'execute', rawInput: { command: 'echo hi' } },
          text: ['after approval'],
        },
      ],
    },
    { autoApprove: false },
  )

  const turn = client.rpc('session/prompt', { sessionId: session.sessionId, prompt: [] })

  const request = await waitFor(() => client.requests[0])
  assert.equal(request.method, 'session/request_permission')
  assert.equal(request.params.sessionId, session.sessionId)
  assert.equal(request.params.toolCall.title, 'Bash')
  assert.deepEqual(request.params.toolCall.rawInput, { command: 'echo hi' })
  assert.deepEqual(
    request.params.options.map((option) => option.optionId),
    ['allow_always', 'allow', 'reject'],
  )

  // The agent is waiting: no text yet, no response yet.
  await sleep(120)
  assert.equal(client.updatesOf('agent_message_chunk').length, 0)

  client.answerRequest(request, { outcome: { outcome: 'selected', optionId: 'allow' } })

  const result = await turn
  assert.equal(result.stopReason, 'end_turn')
  assert.equal(messageText(client), 'after approval')
  assert.equal(client.answeredRequests.length, 1)
})

test('a rejected permission request cancels the turn', async (t) => {
  const { client, session } = await openSession(
    t,
    { prompts: [{ permission: { title: 'Bash', rawInput: { command: 'rm -rf /' } }, text: ['nope'] }] },
    { autoApprove: false },
  )

  const turn = client.rpc('session/prompt', { sessionId: session.sessionId, prompt: [] })
  const request = await waitFor(() => client.requests[0])

  client.answerRequest(request, { outcome: { outcome: 'selected', optionId: 'reject' } })

  const result = await turn
  assert.equal(result.stopReason, 'cancelled')
  assert.equal(messageText(client), '')
})

// ---------------------------------------------------------------------------
// auth failure
// ---------------------------------------------------------------------------

test('the auth-failure scenario yields stopReason refusal with a parseable errorMessage', async (t) => {
  const { client, session } = await openSession(t, {
    prompts: [
      {
        text: [],
        stopReason: 'refusal',
        authFailure: true,
        finishReason: 'refusal',
      },
    ],
  })

  const result = await client.rpc('session/prompt', { sessionId: session.sessionId, prompt: [] })

  assert.equal(result.stopReason, 'refusal')
  assert.equal(result._meta['codebuddy.ai/outcome'], 'FAILED_MODEL_REQUEST')

  const raw = result._meta['codebuddy.ai/errorMessage']
  assert.equal(typeof raw, 'string', 'errorMessage must be a JSON string, not an object')
  const parsed = JSON.parse(raw)
  assert.equal(parsed.code, -32000)
  assert.equal(parsed.message, 'Authentication required')
  assert.equal(parsed.data.statusCode, 401)
  assert.equal(parsed.data.category, 'auth')
})

test('failInitialize makes the process exit 1 without an initialize response', async (t) => {
  const fake = startFakeAcp({ failInitialize: true })
  const client = new AcpClient(fake.child)
  t.after(() => fake.cleanup())

  await assert.rejects(
    client.rpc('initialize', { protocolVersion: 1, clientCapabilities: {} }),
    /closed|timed out/,
  )
  const code = await fake.closed
  assert.equal(code, 1)
})

// ---------------------------------------------------------------------------
// set_model
// ---------------------------------------------------------------------------

test('set_model echoes a known id and rejects an unknown one', async (t) => {
  const { client, session } = await openSession(t, { prompts: [{ text: ['ok'] }] })

  const ok = await client.rpc('session/set_model', {
    sessionId: session.sessionId,
    modelId: 'deepseek-v4.1-flash',
  })
  assert.deepEqual(ok, { modelId: 'deepseek-v4.1-flash' })

  await assert.rejects(
    client.rpc('session/set_model', { sessionId: session.sessionId, modelId: 'gpt-nope' }),
    (err) => {
      assert.equal(err.code, -32602)
      assert.equal(err.rpcError.message, 'unknown model')
      return true
    },
  )

  // The remembered model is reflected by later sessions.
  const next = await client.rpc('session/new', { cwd: process.cwd(), mcpServers: [] })
  assert.equal(next.models.currentModelId, 'deepseek-v4.1-flash')
})

// ---------------------------------------------------------------------------
// MCP bridge
// ---------------------------------------------------------------------------

function startMcpServer() {
  const calls = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      const send = (obj) => {
        const text = JSON.stringify(obj)
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) })
        res.end(text)
      }
      if (req.method !== 'POST') {
        res.writeHead(405)
        res.end()
        return
      }
      let message
      try {
        message = JSON.parse(body)
      } catch {
        res.writeHead(400)
        res.end()
        return
      }
      calls.push(message)

      if (message.method === 'initialize') {
        send({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'test-mcp', version: '0.0.1' },
          },
        })
        return
      }
      if (message.method === 'notifications/initialized') {
        res.writeHead(202)
        res.end()
        return
      }
      if (message.method === 'tools/list') {
        send({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            tools: [
              {
                name: 'echo_probe',
                description: 'Echo text back.',
                inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
              },
            ],
          },
        })
        return
      }
      if (message.method === 'tools/call') {
        send({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            content: [{ type: 'text', text: `ECHOED:${JSON.stringify(message.params?.arguments ?? {})}` }],
            isError: false,
          },
        })
        return
      }
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } })
    })
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({
        url: `http://127.0.0.1:${port}/mcp`,
        calls,
        close: () => new Promise((done) => server.close(done)),
      })
    })
  })
}

test('MCP bridge: http mcpServers get initialize/tools/list/tools/call and the result is folded into the turn', async (t) => {
  const mcp = await startMcpServer()
  t.after(() => mcp.close())

  const { client, session } = await openSession(
    t,
    {
      prompts: [
        {
          text: ['calling tool'],
          mcpCalls: [{ name: 'echo_probe', arguments: { text: 'hello-mcp' } }],
        },
      ],
    },
    {},
    { mcpServers: [{ name: 'client-tools', type: 'http', url: mcp.url, headers: [] }] },
  )

  const result = await client.rpc('session/prompt', {
    sessionId: session.sessionId,
    prompt: [{ type: 'text', text: 'use the echo tool' }],
  })

  assert.equal(result.stopReason, 'end_turn')

  const methods = mcp.calls.map((call) => call.method)
  assert.ok(methods.includes('initialize'), `expected initialize, got ${methods.join(',')}`)
  assert.ok(methods.includes('notifications/initialized'))
  assert.ok(methods.includes('tools/list'))
  assert.ok(methods.includes('tools/call'))

  const toolCall = mcp.calls.find((call) => call.method === 'tools/call')
  assert.deepEqual(toolCall.params, { name: 'echo_probe', arguments: { text: 'hello-mcp' } })

  // The MCP result is folded into the visible output as an agent message chunk.
  assert.ok(
    messageText(client).includes('ECHOED:{"text":"hello-mcp"}'),
    `expected folded MCP output, got ${JSON.stringify(messageText(client))}`,
  )
  assert.equal(client.updatesOf('tool_call_update').at(-1).status, 'completed')
})

test('an unreachable MCP server is non-fatal and is recorded', async (t) => {
  const { client, session, fake } = await openSession(
    t,
    { prompts: [{ text: ['still works'], mcpCalls: [{ name: 'echo_probe', arguments: { text: 'x' } }] }] },
    {},
    // Port 1 on loopback: connection refused, fast and deterministic.
    { mcpServers: [{ name: 'dead', type: 'http', url: 'http://127.0.0.1:1/mcp', headers: [] }] },
  )

  const result = await client.rpc('session/prompt', { sessionId: session.sessionId, prompt: [] })

  assert.equal(result.stopReason, 'end_turn')
  assert.equal(messageText(client), 'still works')

  const records = readRecord(fake.recordPath)
  assert.ok(
    records.some((record) => record.__fakeAcp === true && record.type === 'mcp-error'),
    'expected an mcp-error record entry',
  )
})

// ---------------------------------------------------------------------------
// recordPath
// ---------------------------------------------------------------------------

test('recordPath captures every inbound line', async (t) => {
  const { client, session, fake } = await openSession(t, { prompts: [{ text: ['ok'] }] })

  await client.rpc('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text: 'hello' }] })

  const records = await waitFor(() => {
    const all = readRecord(fake.recordPath)
    return all.length >= 3 ? all : null
  })

  const methods = records.map((record) => record.method)
  assert.deepEqual(methods, ['initialize', 'session/new', 'session/prompt'])
  assert.equal(records[2].params.sessionId, session.sessionId)
  assert.equal(records[2].params.prompt[0].text, 'hello')
  assert.equal(records[0].jsonrpc, '2.0')
})

test('the fake exits cleanly when stdin closes', async (t) => {
  const fake = startFakeAcp({})
  const client = new AcpClient(fake.child)
  t.after(() => fake.cleanup())

  await client.rpc('initialize', { protocolVersion: 1, clientCapabilities: {} })
  const code = await client.close()
  assert.equal(code, 0)
})

// ---------------------------------------------------------------------------
// testkit helpers
// ---------------------------------------------------------------------------

test('sseParse splits Anthropic-style SSE into events', () => {
  const body = [
    'event: message_start',
    'data: {"type":"message_start"}',
    '',
    ': a comment line',
    'event: content_block_delta',
    'data: {"type":"content_block_delta",',
    'data: "index":0}',
    '',
    'data: [DONE]',
    '',
  ].join('\n')

  const events = sseParse(body)
  assert.equal(events.length, 3)
  assert.equal(events[0].event, 'message_start')
  assert.equal(events[0].data, '{"type":"message_start"}')
  assert.equal(events[1].event, 'content_block_delta')
  assert.equal(events[1].data, '{"type":"content_block_delta",\n"index":0}')
  assert.equal(events[2].event, 'message')
  assert.equal(events[2].data, '[DONE]')
  assert.deepEqual(sseParse(''), [])
})

test('waitFor rejects with a useful message on timeout', async () => {
  await assert.rejects(waitFor(() => false, { timeoutMs: 50, intervalMs: 10 }), /timed out after 50ms/)
})

test('startFakeAcp writes its scenario to a file and honours a custom recordPath', async (t) => {
  const dir = (await import('node:fs')).mkdtempSync(join((await import('node:os')).tmpdir(), 'magpie-rec-'))
  const recordPath = join(dir, 'custom-record.jsonl')
  t.after(() => removeDir(dir))

  const fake = startFakeAcp({ prompts: [{ text: ['hi'] }], recordPath })
  const client = new AcpClient(fake.child)
  t.after(async () => {
    await client.close()
    fake.cleanup()
  })

  assert.equal(fake.recordPath, recordPath)
  await client.rpc('initialize', { protocolVersion: 1, clientCapabilities: {} })
  const records = await waitFor(() => (readRecord(recordPath).length ? readRecord(recordPath) : null))
  assert.equal(records[0].method, 'initialize')
})
