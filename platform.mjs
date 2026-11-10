/**
 * CodeBuddy CLI discovery, launch resolution and process helpers for the
 * Magpie / OpenCode CodeBuddy provider.
 *
 * The non-obvious part of this module is Windows. The npm package installs three
 * launchers into the global bin directory:
 *
 *   codebuddy       POSIX shell script with a `#!/usr/bin/env node` shebang
 *   codebuddy.cmd   cmd.exe shim ending in `"%_prog%" "%dp0%\node_modules\..." %*`
 *   codebuddy.ps1   PowerShell shim
 *
 * Node cannot execute the `.cmd`/`.ps1` shims directly: they are batch scripts,
 * so `spawn('codebuddy', ...)` fails with ENOENT because the interpreter is
 * cmd.exe, not Node. Going through cmd.exe / PowerShell would also mangle
 * quoting, so instead we read the shim, find the JavaScript entry it points at
 * and run that entry with `process.execPath`. Argument passing then stays exact,
 * no shell is involved anywhere, and the same code path works on macOS, Linux
 * and Windows.
 */

import fs from 'node:fs/promises'
import pathlib from 'node:path'
import { spawn } from 'node:child_process'

const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD'
const NODE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs'])
const SHEBANG_EXTENSIONS = new Set(['.cmd', '.bat'])
const WINDOWS_EXECUTABLE_EXTENSIONS = new Set(['.exe', '.com'])
const PERMISSION_MODES = new Set([
  'dontAsk',
  'plan',
  'acceptEdits',
  'default',
  'bypassPermissions',
  'auto',
])

const UNSET = (value) => value === undefined || value === null || value === ''

const isWindows = (platform) => platform === 'win32'

/**
 * Path flavour of the target platform, not of the host. Candidates are built for
 * the platform being inspected, so a POSIX lookup performed on Windows must not
 * produce backslashes.
 */
const pathFor = (platform) => (isWindows(platform) ? pathlib.win32 : pathlib.posix)

const isNonEmptyString = (value) => typeof value === 'string' && value.length > 0

/** Split a PATH string using the delimiter of the target platform. */
function splitPathValue(value, platform) {
  const delimiter = pathFor(platform).delimiter
  return String(value)
    .split(delimiter)
    .map((entry) => entry.replace(/^"(.*)"$/, '$1'))
    .filter((entry) => entry.length > 0)
}

/** PATHEXT entries, normalised to start with a dot, in the order they are tried. */
function pathExtensions(env, platform) {
  if (!isWindows(platform)) return ['']
  const raw = isNonEmptyString(env.PATHEXT) ? env.PATHEXT : DEFAULT_PATHEXT
  const extensions = []
  for (const part of raw.split(';')) {
    const trimmed = part.trim()
    if (!trimmed) continue
    const extension = trimmed.startsWith('.') ? trimmed : `.${trimmed}`
    // Windows file systems are case-insensitive, but tests and odd mounts may
    // not be, so try both spellings of each entry.
    for (const variant of [extension, extension.toLowerCase()]) {
      if (!extensions.includes(variant)) extensions.push(variant)
    }
  }
  return extensions.length > 0 ? extensions : DEFAULT_PATHEXT.split(';')
}

function buildCandidates(env, platform, pathOverride) {
  const environment = env ?? process.env
  const targetPlatform = platform ?? process.platform

  // An explicit override is pinned: it is the only candidate and, if it cannot
  // be used, findCodebuddy() reports that instead of quietly using another one.
  if (isNonEmptyString(environment.CODEBUDDY_PATH)) return [environment.CODEBUDDY_PATH]
  if (isNonEmptyString(environment.CODEBUDDY_BIN)) return [environment.CODEBUDDY_BIN]

  const rawPath = isNonEmptyString(pathOverride)
    ? pathOverride
    : isNonEmptyString(environment.PATH)
      ? environment.PATH
      : isNonEmptyString(environment.Path)
        ? environment.Path
        : process.env.PATH ?? ''

  const name = 'codebuddy'
  const extensions = pathExtensions(environment, targetPlatform)
  const candidates = []
  const seen = new Set()

  const push = (candidate) => {
    if (seen.has(candidate)) return
    seen.add(candidate)
    candidates.push(candidate)
  }

  for (const directory of splitPathValue(rawPath, targetPlatform)) {
    const join = pathFor(targetPlatform).join
    if (isWindows(targetPlatform)) {
      // Mirror how Windows itself resolves a command: append each PATHEXT entry
      // first. The extensionless `codebuddy` file shipped by npm is a /bin/sh
      // wrapper that only works inside Git Bash / Cygwin, so it is the last
      // resort on Windows.
      for (const extension of extensions) {
        if (!extension) continue
        push(join(directory, `${name}${extension}`))
      }
      push(join(directory, name))
    } else {
      push(join(directory, name))
    }
  }

  return candidates
}

/**
 * Candidate launcher paths, in the order they should be tried.
 *
 * `env.CODEBUDDY_PATH` / `env.CODEBUDDY_BIN` win over everything; otherwise the
 * name is looked up in `env.PATH` with `env.PATHEXT` on Windows.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {NodeJS.Platform} [platform]
 * @returns {string[]}
 */
export function codebuddyCandidates(env = process.env, platform = process.platform) {
  return buildCandidates(env, platform)
}

async function realpathSafe(target) {
  try {
    return await fs.realpath(target)
  } catch {
    return target
  }
}

async function readFirstLine(file) {
  let handle
  try {
    handle = await fs.open(file, 'r')
    const buffer = Buffer.alloc(512)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return buffer.subarray(0, bytesRead).toString('utf8').split(/\r?\n/, 1)[0] ?? ''
  } catch {
    return ''
  } finally {
    await handle?.close().catch(() => {})
  }
}

/**
 * Parse an npm `.cmd` / `.bat` shim and return the JavaScript entry it runs.
 *
 * npm writes the target as a quoted argument prefixed with the shim's directory:
 *
 *   "%_prog%" "%dp0%\node_modules\@tencent-ai\codebuddy-code\bin\codebuddy" %*
 *
 * Older / hand written shims use `%~dp0` (no trailing `%`) and yarn style shims
 * use `$basedir`. All three are accepted; only paths that contain a
 * `node_modules` segment are considered, so the `%dp0%\node.exe` branch that npm
 * also emits is ignored.
 *
 * @returns {Promise<string|null>} realpath of an existing target file, or null.
 */
async function resolveNpmShimTarget(shimPath) {
  let text
  try {
    text = await fs.readFile(shimPath, 'utf8')
  } catch {
    return null
  }

  const directory = pathlib.dirname(shimPath)
  const pattern = /(?:%~dp0%?|%dp0%|\$basedir)[\\/]+([^"\r\n]+)/gi
  const seen = new Set()

  for (const match of text.matchAll(pattern)) {
    // Drop a trailing `%*` / `%1` style argument placeholder when the shim does
    // not quote the target.
    const raw = match[1].replace(/\s+%[\d*]$/, '').trim()
    if (!/node_modules[\\/]/i.test(raw)) continue
    const relative = raw.replace(/[\\/]+/g, pathlib.sep)
    const target = pathlib.resolve(directory, relative)
    if (seen.has(target)) continue
    seen.add(target)
    try {
      const stats = await fs.stat(target)
      if (stats.isFile()) return await realpathSafe(target)
    } catch {
      // Try the next reference in the shim.
    }
  }

  return null
}

/**
 * Turn a launcher file into the exact command/arguments that start the CLI.
 *
 * @returns {Promise<{command: string, args: string[]}>}
 */
async function resolveLaunch(file, platform) {
  const extension = pathlib.extname(file).toLowerCase()

  if (NODE_EXTENSIONS.has(extension)) {
    return { command: process.execPath, args: [file] }
  }

  if (extension === '') {
    // Extensionless launchers are usually the POSIX shell wrapper; when it is a
    // node script we run it with the current Node binary instead of relying on
    // the file mode / shebang support (Windows has neither).
    const firstLine = await readFirstLine(file)
    if (/^#!.*\bnode\b/i.test(firstLine)) {
      return { command: process.execPath, args: [file] }
    }
    if (isWindows(platform)) {
      // npm also installs an extensionless /bin/sh wrapper that only runs under
      // Git Bash / Cygwin. It names the same node_modules entry with $basedir,
      // so reuse the shim parser rather than refusing a pinned path.
      const target = await resolveNpmShimTarget(file)
      if (target) return { command: process.execPath, args: [target] }
    }
  }

  if (isWindows(platform) && SHEBANG_EXTENSIONS.has(extension)) {
    const target = await resolveNpmShimTarget(file)
    if (!target) {
      throw new Error(
        'Unsupported CodeBuddy launcher; point CODEBUDDY_PATH at the CLI JavaScript entry',
      )
    }
    return { command: process.execPath, args: [target] }
  }

  // `.exe` / `.com` on Windows, or any executable on POSIX: run it directly.
  if (isWindows(platform) && !WINDOWS_EXECUTABLE_EXTENSIONS.has(extension)) {
    // A Windows file that is neither a node script nor a native executable
    // cannot be started without a shell, which this module never uses.
    throw new Error(
      'Unsupported CodeBuddy launcher; point CODEBUDDY_PATH at the CLI JavaScript entry',
    )
  }

  return { command: file, args: [] }
}

/**
 * Locate the CodeBuddy CLI and describe how to start it.
 *
 * Returns `{ command, args, path }` where `path` is the realpath of the launcher
 * file that was found (for a `.cmd` shim that is the shim itself, while
 * `args[0]` is the JavaScript entry it resolves to), or `null` when nothing
 * usable was found. A pinned `CODEBUDDY_PATH` / `CODEBUDDY_BIN` that is unusable
 * throws instead of falling through.
 *
 * @param {{env?: NodeJS.ProcessEnv, path?: string, platform?: NodeJS.Platform, probeVersion?: boolean}} [options]
 * @returns {Promise<{command: string, args: string[], path: string, version?: string}|null>}
 */
export async function findCodebuddy({ env, path: pathOverride, platform, probeVersion = false } = {}) {
  const environment = env ?? process.env
  const targetPlatform = platform ?? process.platform
  const pinnedVariable = isNonEmptyString(environment.CODEBUDDY_PATH)
    ? 'CODEBUDDY_PATH'
    : isNonEmptyString(environment.CODEBUDDY_BIN)
      ? 'CODEBUDDY_BIN'
      : null
  const candidates = buildCandidates(environment, targetPlatform, pathOverride)

  for (const candidate of candidates) {
    let resolved
    try {
      const stats = await fs.stat(candidate)
      if (!stats.isFile()) {
        throw new Error('not a regular file')
      }
      resolved = await realpathSafe(candidate)
    } catch (error) {
      if (pinnedVariable) {
        throw new Error(
          `CodeBuddy launcher from ${pinnedVariable} is not a usable file: ${candidate} (${error.message})`,
        )
      }
      // Defensive: one unreadable PATH entry must not abort the whole search.
      continue
    }

    let launch
    try {
      launch = await resolveLaunch(resolved, targetPlatform)
    } catch (error) {
      if (pinnedVariable) throw error
      continue
    }

    const result = { command: launch.command, args: launch.args, path: resolved }
    if (probeVersion) {
      const version = await codebuddyVersion(result)
      if (version) result.version = version
    }
    return result
  }

  return null
}

/**
 * Spawn the CLI. Never uses a shell, so arguments reach the child verbatim.
 *
 * @param {{command: string, args?: string[]}} launch
 * @param {string[]} [argv]
 * @param {{cwd?: string, env?: NodeJS.ProcessEnv, stdio?: any}} [options]
 */
export function spawnCodebuddy(launch, argv, { cwd, env, stdio } = {}) {
  if (!launch || !isNonEmptyString(launch.command)) {
    throw new TypeError('spawnCodebuddy: launch.command must be a non-empty string')
  }
  const baseArgs = Array.isArray(launch.args) ? launch.args : []
  const extraArgs = Array.isArray(argv) ? argv : []

  return spawn(launch.command, [...baseArgs, ...extraArgs], {
    cwd,
    env,
    shell: false,
    windowsHide: true,
    stdio: stdio ?? ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  })
}

function parseVersion(text) {
  const match = /(\d+\.\d+\.\d+)/.exec(text ?? '')
  return match ? match[1] : null
}

/**
 * Run `<launch> --version` and return the first dotted version in its output.
 * Never throws; returns null on spawn failure, non-zero exit or timeout.
 *
 * @param {{command: string, args?: string[]}} launch
 * @param {{timeoutMs?: number}} [options]
 * @returns {Promise<string|null>}
 */
export async function codebuddyVersion(launch, { timeoutMs = 15000 } = {}) {
  if (!launch || !isNonEmptyString(launch.command)) return null

  const args = [...(Array.isArray(launch.args) ? launch.args : []), '--version']

  return await new Promise((resolve) => {
    let child = null
    let settled = false
    let timer = null

    const finish = (value) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      try {
        child?.kill()
      } catch {
        // The child may already be gone.
      }
      resolve(value)
    }

    try {
      child = spawn(launch.command, args, {
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch {
      resolve(null)
      return
    }

    let stdout = ''
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => {
      stdout += chunk
    })
    // stderr is drained but never parsed: Node itself prints "Node.js v22.20.0"
    // on stderr when a script is missing, which would look like a CLI version.
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', () => {})
    child.on('error', () => finish(null))
    child.on('close', (code) => finish(code === 0 ? parseVersion(stdout) : null))

    timer = setTimeout(() => finish(null), timeoutMs)
  })
}

/**
 * Build the ACP argv for the CLI. Exported so the plugin and its tests agree on
 * the exact flag order and on which flags are omitted.
 *
 * @param {{model?: string, tools?: string, permissionMode?: string, effort?: string, sessionPersistence?: boolean, skipPermissions?: boolean}} [options]
 * @returns {string[]}
 */
export function codebuddyLaunchArgs({
  model,
  tools,
  permissionMode,
  effort,
  sessionPersistence,
  skipPermissions,
} = {}) {
  const args = [
    '--acp',
    '--acp-transport',
    'stdio',
    '--tools',
    isNonEmptyString(tools) ? tools : 'default',
  ]

  if (sessionPersistence === false) {
    args.push('--no-session-persistence')
  }

  if (skipPermissions === true) {
    args.push('--dangerously-skip-permissions')
  } else if (PERMISSION_MODES.has(permissionMode)) {
    args.push('--permission-mode', permissionMode)
  }

  if (!UNSET(model)) {
    args.push('--model', model)
  }

  if (!UNSET(effort)) {
    args.push('--effort', effort)
  }

  return args
}
