import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ChildProcess } from 'node:child_process'

import {
  codebuddyCandidates,
  findCodebuddy,
  spawnCodebuddy,
  codebuddyVersion,
  codebuddyLaunchArgs,
} from '../platform.mjs'

const isWindows = process.platform === 'win32'

/** Create an isolated temp directory and register its cleanup on the test. */
async function makeTempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'magpie-codebuddy-'))
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })
  return dir
}

async function writeFile(file, contents, mode = 0o644) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, contents, 'utf8')
  await fs.chmod(file, mode)
  return file
}

/**
 * A minimal npm-style Windows shim. The target it points at is created too, so
 * the shim can actually be resolved the way a real install would be.
 */
function npmShimText(targetRelative) {
  return [
    '@ECHO off',
    'GOTO start',
    ':find_dp0',
    'SET dp0=%~dp0',
    'EXIT /b',
    ':start',
    'SETLOCAL',
    'CALL :find_dp0',
    '',
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ') ELSE (',
    '  SET "_prog=node"',
    '  SET PATHEXT=%PATHEXT:;.JS;=;%',
    ')',
    '',
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${targetRelative}" %*`,
    '',
  ].join('\r\n')
}

test('codebuddyCandidates prefers CODEBUDDY_PATH over everything else', () => {
  const candidates = codebuddyCandidates(
    { CODEBUDDY_PATH: 'C:\\custom\\codebuddy.cmd', PATH: 'C:\\bin', PATHEXT: '.CMD' },
    'win32',
  )
  assert.deepEqual(candidates, ['C:\\custom\\codebuddy.cmd'])
})

test('codebuddyCandidates falls back to CODEBUDDY_BIN', () => {
  const candidates = codebuddyCandidates(
    { CODEBUDDY_BIN: '/opt/codebuddy/bin/codebuddy', PATH: '/usr/bin:/opt/bin' },
    'linux',
  )
  assert.deepEqual(candidates, ['/opt/codebuddy/bin/codebuddy'])
})

test('codebuddyCandidates expands PATH with PATHEXT on win32', () => {
  const candidates = codebuddyCandidates(
    { PATH: 'C:\\a;C:\\b', PATHEXT: '.COM;.EXE;.BAT;.CMD' },
    'win32',
  )
  assert.ok(candidates.includes('C:\\a\\codebuddy'))
  assert.ok(candidates.includes('C:\\a\\codebuddy.cmd'))
  assert.ok(candidates.includes('C:\\a\\codebuddy.CMD'))
  assert.ok(candidates.includes('C:\\b\\codebuddy.cmd'))
  assert.ok(
    candidates.indexOf('C:\\a\\codebuddy.cmd') < candidates.indexOf('C:\\b\\codebuddy.cmd'),
    'PATH order must be preserved',
  )
  // The extensionless npm file is a /bin/sh wrapper, so PATHEXT matches win.
  assert.ok(
    candidates.indexOf('C:\\a\\codebuddy.cmd') < candidates.indexOf('C:\\a\\codebuddy'),
    'PATHEXT matches must be tried before the bare name',
  )
})

test('codebuddyCandidates uses the bare name on POSIX', () => {
  const candidates = codebuddyCandidates({ PATH: '/usr/local/bin:/usr/bin' }, 'linux')
  assert.deepEqual(candidates, ['/usr/local/bin/codebuddy', '/usr/bin/codebuddy'])
})

test('win32 .cmd shim resolves to the node entry it points at', async (t) => {
  const dir = await makeTempDir(t)
  const target = await writeFile(
    path.join(dir, 'node_modules', '@tencent-ai', 'codebuddy-code', 'bin', 'codebuddy'),
    '#!/usr/bin/env node\nconsole.log("fake")\n',
    0o755,
  )
  const shim = await writeFile(
    path.join(dir, 'codebuddy.cmd'),
    npmShimText('node_modules\\@tencent-ai\\codebuddy-code\\bin\\codebuddy'),
  )

  const launch = await findCodebuddy({
    env: { CODEBUDDY_PATH: shim },
    platform: 'win32',
  })

  assert.ok(launch, 'shim should resolve')
  assert.equal(launch.command, process.execPath)
  assert.equal(launch.args.length, 1)
  assert.equal(launch.args[0], await fs.realpath(target))
  assert.equal(launch.path, await fs.realpath(shim))
})

test('win32 .cmd shim without a parseable node_modules target throws', async (t) => {
  const dir = await makeTempDir(t)
  const shim = await writeFile(
    path.join(dir, 'codebuddy.cmd'),
    '@ECHO off\r\n"%_prog%" "%dp0%\\cli.js" %*\r\n',
  )

  await assert.rejects(
    () => findCodebuddy({ env: { CODEBUDDY_PATH: shim }, platform: 'win32' }),
    /Unsupported CodeBuddy launcher/,
  )
})

test('win32 extensionless /bin/sh wrapper is resolved through its $basedir entry', async (t) => {
  const dir = await makeTempDir(t)
  const target = await writeFile(
    path.join(dir, 'node_modules', '@tencent-ai', 'codebuddy-code', 'bin', 'codebuddy'),
    '#!/usr/bin/env node\nconsole.log("fake")\n',
    0o755,
  )
  // npm also ships this shell wrapper next to the .cmd shim; it only runs under
  // Git Bash / Cygwin, so on Windows it must be translated, not executed.
  const wrapper = await writeFile(
    path.join(dir, 'codebuddy'),
    [
      '#!/bin/sh',
      'basedir=$(dirname "$(echo "$0" | sed -e \'s,\\\\,/,g\')")',
      '',
      'if [ -x "$basedir/node" ]; then',
      '  exec "$basedir/node"  "$basedir/node_modules/@tencent-ai/codebuddy-code/bin/codebuddy" "$@"',
      'fi',
      '',
    ].join('\n'),
    0o755,
  )

  const launch = await findCodebuddy({ env: { CODEBUDDY_PATH: wrapper }, platform: 'win32' })

  assert.ok(launch)
  assert.equal(launch.command, process.execPath)
  assert.deepEqual(launch.args, [await fs.realpath(target)])
})

test('extensionless script with a node shebang runs under process.execPath', async (t) => {
  const dir = await makeTempDir(t)
  const script = await writeFile(
    path.join(dir, 'codebuddy'),
    '#!/usr/bin/env node\nconsole.log("hi")\n',
    0o755,
  )

  const launch = await findCodebuddy({ env: { CODEBUDDY_PATH: script }, platform: 'linux' })

  assert.ok(launch)
  assert.equal(launch.command, process.execPath)
  assert.deepEqual(launch.args, [await fs.realpath(script)])
})

test('.js launcher runs under process.execPath', async (t) => {
  const dir = await makeTempDir(t)
  const script = await writeFile(path.join(dir, 'cli.js'), 'console.log("hi")\n')

  const launch = await findCodebuddy({ env: { CODEBUDDY_PATH: script } })

  assert.ok(launch)
  assert.equal(launch.command, process.execPath)
  assert.deepEqual(launch.args, [await fs.realpath(script)])
})

test('.exe on win32 is executed directly', async (t) => {
  const dir = await makeTempDir(t)
  const exe = await writeFile(path.join(dir, 'codebuddy.exe'), 'MZ fake binary\n')

  const launch = await findCodebuddy({ env: { CODEBUDDY_PATH: exe }, platform: 'win32' })

  assert.ok(launch)
  assert.equal(launch.command, await fs.realpath(exe))
  assert.deepEqual(launch.args, [])
})

test('POSIX executable is executed directly', async (t) => {
  const dir = await makeTempDir(t)
  const binary = await writeFile(
    path.join(dir, 'codebuddy'),
    '#!/bin/sh\nexec node "$0.js" "$@"\n',
    0o755,
  )

  const launch = await findCodebuddy({ env: { CODEBUDDY_PATH: binary }, platform: 'linux' })

  assert.ok(launch)
  assert.equal(launch.command, await fs.realpath(binary))
  assert.deepEqual(launch.args, [])
})

test('explicit CODEBUDDY_PATH that does not exist throws', async (t) => {
  const dir = await makeTempDir(t)
  const missing = path.join(dir, 'nope', 'codebuddy')

  await assert.rejects(
    () => findCodebuddy({ env: { CODEBUDDY_PATH: missing } }),
    /CODEBUDDY_PATH/,
  )
})

test('CODEBUDDY_PATH pointing at a directory throws', async (t) => {
  const dir = await makeTempDir(t)
  await assert.rejects(
    () => findCodebuddy({ env: { CODEBUDDY_PATH: dir } }),
    /CODEBUDDY_PATH/,
  )
})

test('PATH search skips a missing candidate and takes the first usable one', async (t) => {
  const dir = await makeTempDir(t)
  const first = await writeFile(
    path.join(dir, 'one', 'codebuddy'),
    '#!/usr/bin/env node\nconsole.log("one")\n',
    0o755,
  )
  const second = await writeFile(
    path.join(dir, 'two', 'codebuddy'),
    '#!/usr/bin/env node\nconsole.log("two")\n',
    0o755,
  )

  const missingDir = path.join(dir, 'missing')
  const searchPath = [missingDir, path.dirname(first), path.dirname(second)].join(path.delimiter)

  const launch = await findCodebuddy({ env: { PATH: searchPath } })

  assert.ok(launch)
  assert.equal(launch.path, await fs.realpath(first))
  assert.equal(launch.command, process.execPath)
})

test('PATH search returns null when nothing is found', async (t) => {
  const dir = await makeTempDir(t)
  const launch = await findCodebuddy({ env: { PATH: path.join(dir, 'empty') } })
  assert.equal(launch, null)
})

test('codebuddyLaunchArgs defaults', () => {
  assert.deepEqual(codebuddyLaunchArgs(), [
    '--acp',
    '--acp-transport',
    'stdio',
    '--tools',
    'default',
  ])
})

test('codebuddyLaunchArgs skipPermissions', () => {
  const args = codebuddyLaunchArgs({ skipPermissions: true, permissionMode: 'plan' })
  assert.ok(args.includes('--dangerously-skip-permissions'))
  assert.ok(!args.includes('--permission-mode'))
})

test('codebuddyLaunchArgs permissionMode', () => {
  const args = codebuddyLaunchArgs({ permissionMode: 'acceptEdits' })
  const index = args.indexOf('--permission-mode')
  assert.ok(index >= 0)
  assert.equal(args[index + 1], 'acceptEdits')
})

test('codebuddyLaunchArgs ignores an unknown permissionMode', () => {
  const args = codebuddyLaunchArgs({ permissionMode: 'root' })
  assert.ok(!args.includes('--permission-mode'))
})

test('codebuddyLaunchArgs model and effort', () => {
  const args = codebuddyLaunchArgs({ model: 'claude-sonnet-4', effort: 'high' })
  assert.equal(args[args.indexOf('--model') + 1], 'claude-sonnet-4')
  assert.equal(args[args.indexOf('--effort') + 1], 'high')
})

test('codebuddyLaunchArgs omits empty values and never adds --effort by default', () => {
  const args = codebuddyLaunchArgs({
    model: '',
    effort: '',
    tools: '',
    permissionMode: '',
    skipPermissions: false,
  })
  assert.deepEqual(args, ['--acp', '--acp-transport', 'stdio', '--tools', 'default'])
  assert.ok(!args.includes('--effort'))
  assert.ok(!args.includes('--model'))
  assert.ok(!args.includes('--dangerously-skip-permissions'))
})

test('codebuddyLaunchArgs sessionPersistence false', () => {
  const args = codebuddyLaunchArgs({ sessionPersistence: false })
  assert.ok(args.includes('--no-session-persistence'))
  assert.ok(!codebuddyLaunchArgs({ sessionPersistence: true }).includes('--no-session-persistence'))
})

test('codebuddyLaunchArgs keeps a custom tools value', () => {
  const args = codebuddyLaunchArgs({ tools: 'none' })
  assert.equal(args[args.indexOf('--tools') + 1], 'none')
})

test('codebuddyVersion returns null when the launcher cannot run', async (t) => {
  const dir = await makeTempDir(t)
  const version = await codebuddyVersion({
    command: process.execPath,
    args: [path.join(dir, 'does-not-exist.js')],
  })
  assert.equal(version, null)
})

test('codebuddyVersion returns null for a non-existent command', async () => {
  const version = await codebuddyVersion({ command: 'definitely-not-a-real-binary-xyz' })
  assert.equal(version, null)
})

test('codebuddyVersion parses the version from a fake CLI', async (t) => {
  const dir = await makeTempDir(t)
  const script = await writeFile(
    path.join(dir, 'fake-cli.mjs'),
    'process.stdout.write("fake-codebuddy 1.2.3\\n")\n',
  )
  const version = await codebuddyVersion({ command: process.execPath, args: [script] })
  assert.equal(version, '1.2.3')
})

test('codebuddyVersion respects the timeout', async (t) => {
  const dir = await makeTempDir(t)
  const script = await writeFile(
    path.join(dir, 'slow-cli.mjs'),
    'setTimeout(() => process.stdout.write("9.9.9\\n"), 5000)\n',
  )
  const started = Date.now()
  const version = await codebuddyVersion(
    { command: process.execPath, args: [script] },
    { timeoutMs: 300 },
  )
  assert.equal(version, null)
  assert.ok(Date.now() - started < 3000, 'must not wait for the child')
})

test('spawnCodebuddy passes argv through without a shell', async (t) => {
  const dir = await makeTempDir(t)
  const script = await writeFile(
    path.join(dir, 'echo-argv.mjs'),
    'process.stdout.write(process.argv.slice(2).join(","))\n',
  )

  const child = spawnCodebuddy(
    { command: process.execPath, args: [script] },
    ['--acp', '--tools', 'default'],
    { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  assert.ok(child instanceof ChildProcess)
  assert.equal(child.spawnargs.includes('--tools'), true)

  let out = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    out += chunk
  })
  const code = await new Promise((resolve) => child.on('close', resolve))
  assert.equal(code, 0)
  assert.equal(out, '--acp,--tools,default')
})

test('real CodeBuddy CLI reports a dotted version (optional)', async (t) => {
  const launch = await findCodebuddy()
  if (!launch) {
    t.skip('no CodeBuddy CLI installed on this machine')
    return
  }
  const version = await codebuddyVersion(launch)
  assert.ok(version, 'codebuddy --version should print a version')
  assert.match(version, /^\d+\.\d+\.\d+$/)
})
