import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  stopTrackedChildren,
  trackChild,
  trackedProcessCount,
  untrackChild,
} from '../process-lifecycle.mjs'

const ACP_MODULE = fileURLToPath(new URL('../acp.mjs', import.meta.url))

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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
  assert.fail(`process ${pid} is still running`)
}

async function waitForReady(child) {
  let output = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    output += chunk
  })
  for (let i = 0; i < 200; i++) {
    if (output.includes('ready')) return
    await delay(25)
  }
  assert.fail(`the plugin host never became ready: ${output}`)
}

function killQuietly(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {}
  }
}

test('a tracked process group is reaped on shutdown', { skip: process.platform === 'win32' }, async (t) => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true,
    stdio: 'ignore',
  })
  t.after(() => killQuietly(child.pid))
  // The child leads its own group, exactly like spawnCodebuddy's CLI does.
  await new Promise((resolve) => child.once('spawn', resolve))
  trackChild(child, { group: true })
  assert.equal(trackedProcessCount(), 1)
  assert.equal(stopTrackedChildren(), 1, 'the running child is signalled')
  await waitUntilStopped(child.pid)
  assert.equal(trackedProcessCount(), 0, 'a reaped child is forgotten')
  assert.equal(stopTrackedChildren(), 0, 'nothing is signalled twice')
})

test('an untracked child is left alone', { skip: process.platform === 'win32' }, async (t) => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true,
    stdio: 'ignore',
  })
  t.after(() => killQuietly(child.pid))
  await new Promise((resolve) => child.once('spawn', resolve))
  trackChild(child, { group: true })
  untrackChild(child)
  assert.equal(trackedProcessCount(), 0)
  assert.equal(stopTrackedChildren(), 0)
  assert.ok(await running(child.pid), 'a child the plugin does not own is never signalled')
})

test('the shutdown hooks are installed once, however many children are tracked', () => {
  const counts = () => ({
    exit: process.listenerCount('exit'),
    signals: ['SIGHUP', 'SIGINT', 'SIGTERM'].map((signal) => process.listenerCount(signal)),
  })
  const fake = (pid) => ({ pid, exitCode: null, signalCode: null, once() {}, kill: () => true })
  const first = fake(2 ** 22)
  const second = fake(2 ** 22 + 1)
  trackChild(first)
  const afterFirst = counts()
  trackChild(second)
  try {
    assert.deepEqual(counts(), afterFirst, 'a second child adds no hooks')
    assert.ok(afterFirst.exit >= 1, 'exit is handled')
    assert.ok(afterFirst.signals.every((count) => count >= 1), 'every terminating signal is handled')
  } finally {
    untrackChild(first)
    untrackChild(second)
  }
})

test('a host that is asked to stop takes the CLI and its tools with it', { skip: process.platform === 'win32' }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'magpie-lifecycle-'))
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
// Keep running after stdin is destroyed: only a real kill ends this process.
setInterval(() => {}, 1000)
`)
  const hostScript = path.join(directory, 'host.mjs')
  await fs.writeFile(hostScript, `
import { openCodeBuddySession } from ${JSON.stringify(ACP_MODULE)}
const [script, pidFile] = process.argv.slice(2)
await openCodeBuddySession({
  launch: { command: process.execPath, args: [script, 'descendant', pidFile] },
  startTimeoutMs: 10000,
})
// The session is open and tracked; now wait to be stopped like a supervised host.
process.stdout.write('ready\\n')
setInterval(() => {}, 1000)
`)
  const pidFile = path.join(directory, 'pid.json')
  const host = spawn(process.execPath, [hostScript, script, pidFile], {
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  const pids = []
  t.after(() => {
    try {
      host.kill('SIGKILL')
    } catch {}
    for (const pid of pids) killQuietly(pid)
  })
  await waitForReady(host)
  const { pid, descendant } = JSON.parse(await fs.readFile(pidFile, 'utf8'))
  pids.push(pid, descendant)
  assert.ok(await running(pid), 'the CLI is running while the host lives')
  assert.ok(await running(descendant), 'so is the tool it spawned')

  // A supervisor stops the host the way launchd or a package manager does:
  // one SIGTERM, no chance to call stop().
  host.kill('SIGTERM')
  await new Promise((resolve) => host.once('close', resolve))
  await waitUntilStopped(pid)
  await waitUntilStopped(descendant)
})
