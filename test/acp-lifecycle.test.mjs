import { test } from 'node:test'
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { CodeBuddySession, openCodeBuddySession } from '../acp.mjs'

function fakeChild(pid = 987654321) {
  const child = new EventEmitter()
  Object.assign(child, {
    pid,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null,
    kill(signal) {
      child.signalCode = signal
      queueMicrotask(() => child.emit('close', null, signal))
      return true
    },
  })
  return child
}

function mockSpawn(t, child, onSpawn) {
  t.mock.method(childProcess, 'spawn', (...args) => {
    queueMicrotask(() => onSpawn?.(child))
    return child
  })
  t.mock.method(process, 'kill', (_pid, signal) => child.kill(signal))
  syncBuiltinESMExports()
  t.after(() => {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  })
}

const options = { launch: { command: 'fake-codebuddy', args: ['base argument'] }, argv: ['extra argument'], startTimeoutMs: 50 }

function answerHandshake(child) {
  child.stdin.on('data', (data) => {
    const request = JSON.parse(data)
    const result = request.method === 'initialize' ? { protocolVersion: 1 } : { sessionId: 'fake-session' }
    queueMicrotask(() => child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n'))
  })
}

test('ACP uses the shared no-shell launcher and removes startup timer/listeners on success', async (t) => {
  const child = fakeChild()
  answerHandshake(child)
  mockSpawn(t, child, () => child.emit('spawn'))
  const timers = new Set()
  const originalSetTimeout = globalThis.setTimeout
  const originalClearTimeout = globalThis.clearTimeout
  t.mock.method(globalThis, 'setTimeout', (...args) => {
    const timer = originalSetTimeout(...args)
    timers.add(timer)
    return timer
  })
  t.mock.method(globalThis, 'clearTimeout', (timer) => {
    timers.delete(timer)
    return originalClearTimeout(timer)
  })
  const session = await openCodeBuddySession(options)
  assert.equal(child.listenerCount('spawn'), 0)
  assert.equal(child.listenerCount('error'), 1, 'only the connection error handler remains')
  assert.equal(timers.size, 0, 'spawn and handshake timers must all be cleared')
  const [command, argv, spawnOptions] = childProcess.spawn.mock.calls[0].arguments
  assert.equal(command, 'fake-codebuddy')
  assert.deepEqual(argv, ['base argument', 'extra argument'])
  assert.equal(spawnOptions.shell, false)
  assert.equal(spawnOptions.windowsHide, true)
  assert.equal(spawnOptions.detached, process.platform !== 'win32')
  await session.stop()
})

test('ACP spawn errors remove startup listeners and finish cleanup', async (t) => {
  const child = fakeChild(undefined)
  child.pid = undefined
  mockSpawn(t, child, () => {
    child.emit('error', new Error('fake spawn failure'))
    queueMicrotask(() => {
      child.exitCode = -2
      child.emit('close', -2)
    })
  })
  await assert.rejects(openCodeBuddySession(options), /fake spawn failure/)
  assert.equal(child.listenerCount('spawn'), 0)
  assert.equal(child.listenerCount('error'), 1)
  assert.equal(child.listenerCount('close'), 1, 'stop leaves only the connection close handler')
  assert.equal(child.stdin.destroyed, true)
  assert.equal(process.kill.mock.callCount(), 0)
})

test('ACP spawn timeout stops the child and removes startup listeners', async (t) => {
  const child = fakeChild()
  mockSpawn(t, child)
  // The production timers are unrefed; retain a handle while testing a stalled spawn.
  const keepAlive = setInterval(() => {}, 1000)
  t.after(() => clearInterval(keepAlive))
  await assert.rejects(openCodeBuddySession({ ...options, startTimeoutMs: 10 }), /process did not start/)
  assert.equal(child.listenerCount('spawn'), 0)
  assert.equal(child.listenerCount('error'), 1)
  assert.equal(child.listenerCount('close'), 1)
  assert.equal(child.signalCode, 'SIGKILL')
})

test('ACP stop never signals protected or invalid PIDs', async (t) => {
  const signals = t.mock.method(process, 'kill', () => assert.fail('must not signal a protected PID'))
  for (const pid of [undefined, null, 0, 1, -1, -123, NaN, '123', process.pid]) {
    const child = fakeChild()
    child.pid = pid
    child.exitCode = 0
    child.kill = () => assert.fail('must not kill a protected PID')
    await new CodeBuddySession({ child }).stop()
  }
  assert.equal(signals.mock.callCount(), 0)
})

test('ACP stop falls back to the child if POSIX group signalling fails', { skip: process.platform === 'win32' }, async (t) => {
  const child = fakeChild()
  const signals = t.mock.method(process, 'kill', () => { throw new Error('group gone') })
  await new CodeBuddySession({ child }).stop()
  assert.deepEqual(signals.mock.calls[0].arguments, [-child.pid, 'SIGKILL'])
  assert.equal(child.signalCode, 'SIGKILL')
})

async function temporaryCli(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'magpie-acp-lifecycle-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const script = path.join(directory, 'fake-cli.mjs')
  await fs.writeFile(script, `
import { writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
const [stage, pidFile] = process.argv.slice(2)
let descendant
if (stage === 'descendant') {
  descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' })
}
writeFileSync(pidFile, JSON.stringify({ pid: process.pid, descendant: descendant?.pid }))
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line)
  if (request.method === stage) return
  const result = request.method === 'initialize' ? { protocolVersion: 1 } : { sessionId: 'fake-session' }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n')
})
// Keep running after stdin is destroyed: cleanup must actually terminate us.
setInterval(() => {}, 1000)
`)
  return { directory, script }
}

async function running(pid) {
  try {
    process.kill(pid, 0)
    if (process.platform === 'linux') {
      // A killed orphan may briefly await init's reaper; it no longer runs.
      const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8')
      if (stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z')) return false
    }
    return true
  } catch (error) {
    if (error.code === 'ESRCH' || error.code === 'ENOENT') return false
    throw error
  }
}

async function waitUntilStopped(pid) {
  for (let i = 0; i < 100; i++) {
    if (!(await running(pid))) return
    await delay(20)
  }
  assert.fail(`fake CLI process ${pid} is still running`)
}

for (const stage of ['initialize', 'session/new']) {
  test(`ACP ${stage} timeout terminates the fake CLI`, async (t) => {
    const { directory, script } = await temporaryCli(t)
    const pidFile = path.join(directory, 'pid.json')
    await assert.rejects(openCodeBuddySession({
      launch: { command: process.execPath, args: [script, stage, pidFile] },
      startTimeoutMs: 1000,
    }), new RegExp(`${stage} timed out`))
    const { pid } = JSON.parse(await fs.readFile(pidFile, 'utf8'))
    await waitUntilStopped(pid)
  })
}

test('ACP stop terminates the POSIX process group including descendants', { skip: process.platform === 'win32' }, async (t) => {
  const { directory, script } = await temporaryCli(t)
  const pidFile = path.join(directory, 'pid.json')
  const session = await openCodeBuddySession({
    launch: { command: process.execPath, args: [script, 'descendant', pidFile] },
    startTimeoutMs: 1000,
  })
  t.after(() => session.stop())
  const { pid, descendant } = JSON.parse(await fs.readFile(pidFile, 'utf8'))
  assert.ok(await running(pid))
  assert.ok(await running(descendant))
  await session.stop()
  await waitUntilStopped(pid)
  await waitUntilStopped(descendant)
})
