// Tying the CLI's lifetime to the process that started it.
//
// spawnCodebuddy starts the CLI in its own process group (detached) so stop()
// can reap it together with the tools it spawned. The other side of that choice
// is that the operating system no longer ends the child when this process ends:
// a restart, a supervisor's SIGTERM or a crash leaves every `codebuddy --acp`
// running, reparented to init and invisible to the next host process — which
// starts its own children and never looks at the old ones again. A leaked CLI
// keeps its session, its tools and its memory for as long as the machine runs.
//
// The children are therefore kept in one set here and killed when this process
// goes away. Nothing else in the plugin needs to know about it, and nothing is
// killed that this process did not start itself.

const TERMINATING_SIGNALS = ["SIGHUP", "SIGINT", "SIGTERM"]

// Default exit codes for a host that dies of a signal it re-raised.
const SIGNAL_NUMBERS = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 }

// child -> { group, forget }
const live = new Map()
let installed = false

const isRunning = (child) => child.exitCode === null && child.signalCode === null

/**
 * Signal one child, by process group when it leads its own.
 *
 * `group` is only ever set for children this plugin spawned detached: their
 * group id is their pid, so the whole tree goes down and nothing else is
 * touched. Signalling `-pid` for any other child would name this process's own
 * group and take the host with it.
 */
function signalChild(child, signal, group) {
  const pid = child.pid
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return false
  if (group && process.platform !== "win32") {
    try {
      process.kill(-pid, signal)
      return true
    } catch {
      // The group is gone already, or the child never got one: fall back.
    }
  }
  try {
    child.kill(signal)
    return true
  } catch {
    return false
  }
}

function reRaise(signal) {
  // Adding a listener replaces Node's default "terminate on this signal", so the
  // signal is raised again once nothing else is listening. Cleanup must not be
  // the reason a stopped host keeps running.
  const number = SIGNAL_NUMBERS[signal] ?? 0
  try {
    process.kill(process.pid, signal)
  } catch {
    process.exit(number ? 128 + number : 1)
  }
}

function install() {
  if (installed) return
  installed = true
  // `exit` covers an orderly shutdown; the signals cover a supervisor stopping
  // or restarting this process, which is how the leak shows up in practice.
  process.on("exit", () => stopTrackedChildren())
  for (const signal of TERMINATING_SIGNALS) {
    const onSignal = () => {
      stopTrackedChildren()
      process.removeListener(signal, onSignal)
      if (process.listenerCount(signal) === 0) reRaise(signal)
    }
    process.on(signal, onSignal)
  }
}

/**
 * Start reaping `child` if this process ends before it does.
 *
 * Call with `{ group: true }` for a child spawned detached on POSIX, so its
 * process group is reaped too. Tracking is dropped once the child is closed —
 * after that its pid may belong to something else.
 */
export function trackChild(child, { group = false } = {}) {
  if (!child || typeof child.once !== "function") return
  if (!Number.isInteger(child.pid) || child.pid <= 1) return
  if (live.has(child)) return
  // close, not exit: a descendant can outlive the CLI while holding its stdio
  // pipes open, which is exactly when the group still has to be reaped.
  const forget = () => {
    live.delete(child)
    child.removeListener?.("close", forget)
  }
  live.set(child, { group, forget })
  install()
  child.once("close", forget)
}

/** Stop reaping `child`; its stop path has already dealt with the process. */
export function untrackChild(child) {
  live.get(child)?.forget()
}

/**
 * Kill every tracked child still running, default by process group.
 *
 * Returns how many were signalled. Synchronous on purpose: this also runs from
 * an `exit` handler, where nothing else is allowed to happen.
 */
export function stopTrackedChildren(signal = "SIGKILL") {
  let stopped = 0
  for (const [child, { group, forget }] of live) {
    forget()
    if (!isRunning(child)) continue
    if (signalChild(child, signal, group)) stopped += 1
  }
  return stopped
}

/** How many children are currently tracked. Exported for the tests. */
export function trackedProcessCount() {
  return live.size
}
