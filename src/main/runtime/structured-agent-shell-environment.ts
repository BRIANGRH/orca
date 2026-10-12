import {
  captureLoginShellEnvironment,
  LOGIN_SHELL_SPAWN_TIMEOUT_MS,
  type LoginShellEnvironmentCapture
} from '../startup/login-shell-environment'
import { mergePersistedWindowsPathAsync } from '../pty/windows-environment-path'
import type { GlobalSettings } from '../../shared/global-settings-types'
import {
  nativeChatShellEnvironmentPolicy,
  type NativeChatShellEnvironmentPolicy
} from '../../shared/native-chat-shell-environment'

// Why: with the whole shell off, the child must still find its CLI and keep locale and agent socket.
const BASELINE_SHELL_VARIABLES = ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'SSH_AUTH_SOCK']

function definedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const defined: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      defined[key] = value
    }
  }
  return defined
}

/** Overlays shell variables on Orca's env; win32 names are case-insensitive, so drop the base spelling. */
function overlayShellVariables(
  base: Record<string, string>,
  shellVariables: Record<string, string>,
  platform: NodeJS.Platform
): Record<string, string> {
  const merged = { ...base }
  if (platform === 'win32') {
    const overlaid = new Set(Object.keys(shellVariables).map((key) => key.toUpperCase()))
    for (const key of Object.keys(merged)) {
      if (overlaid.has(key.toUpperCase())) {
        delete merged[key]
      }
    }
  }
  return { ...merged, ...shellVariables }
}

function pickShellVariables(
  shellEnv: NodeJS.ProcessEnv,
  names: readonly string[],
  platform: NodeJS.Platform
): Record<string, string> {
  const normalize = (key: string): string => (platform === 'win32' ? key.toUpperCase() : key)
  const allowed = new Set([...BASELINE_SHELL_VARIABLES, ...names].map(normalize))
  const picked: Record<string, string> = {}
  for (const [key, value] of Object.entries(definedEnv(shellEnv))) {
    if (allowed.has(normalize(key))) {
      picked[key] = value
    }
  }
  return picked
}

/**
 * The env every structured chat child starts from, before its provider pins an account.
 * Inheriting everything is the login-shell snapshot as-is; otherwise Orca's own env plus
 * the baseline and listed shell variables.
 */
export function structuredAgentBaseEnvironment(input: {
  shellEnv: NodeJS.ProcessEnv
  policy: NativeChatShellEnvironmentPolicy
  processEnv?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
}): Record<string, string> {
  if (input.policy.inheritAll) {
    return definedEnv(input.shellEnv)
  }
  const platform = input.platform ?? process.platform
  return overlayShellVariables(
    definedEnv(input.processEnv ?? process.env),
    pickShellVariables(input.shellEnv, input.policy.names, platform),
    platform
  )
}

/** Settles when `pending` does, or after one profile-loading shell's timeout, whichever is first. */
async function withinShellTimeout(pending: Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    pending.then(
      () => {},
      () => {}
    ),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, LOGIN_SHELL_SPAWN_TIMEOUT_MS)
    })
  ])
  clearTimeout(timer)
}

/** The base env every local agent launch on this host starts from, read from current settings. */
export async function resolveHostAgentBaseEnvironment(
  settings: Pick<
    GlobalSettings,
    'nativeChatInheritShellEnvironment' | 'nativeChatShellEnvironmentVariables'
  >
): Promise<Record<string, string>> {
  return structuredAgentBaseEnvironment({
    shellEnv: await hostShellEnvironment().resolve(),
    policy: nativeChatShellEnvironmentPolicy(settings)
  })
}

/** For a check that found no runnable agent: joins or starts the refresh launches share. */
export function refreshHostAgentBaseEnvironmentAfterMiss(): Promise<void> {
  return hostShellEnvironment().refreshAfterMissingProgram()
}

export type StructuredAgentEnvironmentSources = {
  resolveEnvironment?: () => Promise<NodeJS.ProcessEnv>
  resolveShellEnvironmentPolicy?: () => NativeChatShellEnvironmentPolicy
  resolveLaunchEnv?: () => Promise<NodeJS.ProcessEnv>
  resolveLaunchEnvOverlay?: () => Promise<Record<string, string>> | Record<string, string>
  resolveCodexOverrides?: () => NodeJS.ProcessEnv
}

type ShellSnapshot = {
  env: NodeJS.ProcessEnv
  capturedAt: number
  /** The profile-loading shell produced it, rather than Orca falling back to its own env. */
  profileLoaded: boolean
}

// Why: long enough that a burst of starts shares one capture, short enough that a CLI
// installed on the host reaches new chats without a restart.
const SHELL_ENVIRONMENT_TTL_MS = 10_000

function isStale(snapshot: ShellSnapshot): boolean {
  return Date.now() - snapshot.capturedAt >= SHELL_ENVIRONMENT_TTL_MS
}

/**
 * One capture of the host shell environment. Windows loads the PowerShell profile until a load
 * succeeds, at most once per TTL; otherwise a refresh only rereads the saved PATH.
 */
async function captureHostShellEnvironment(
  previous: ShellSnapshot | null
): Promise<LoginShellEnvironmentCapture> {
  if (process.platform !== 'win32') {
    // Why: the first capture shares a run a startup reader already began; later ones need a fresh run.
    return captureLoginShellEnvironment({ force: previous !== null })
  }
  const loaded = previous?.profileLoaded ? previous.env : null
  const env = { ...(loaded ?? process.env) }
  await mergePersistedWindowsPathAsync(env, { forceRefresh: true })
  if (loaded) {
    return { status: 'captured', env }
  }
  return previous && !isStale(previous)
    ? { status: 'fallback', env }
    : captureLoginShellEnvironment({ force: true, env })
}

type ShellEnvironment = {
  resolve: () => Promise<NodeJS.ProcessEnv>
  /** For a launch that found no program in the snapshot: joins or starts one refresh, waiting at
   *  most one shell's timeout. */
  refreshAfterMissingProgram: () => Promise<void>
}

/**
 * Stale-while-refresh: the first capture starts at creation; later acquisitions get the last
 * snapshot at once and, once it is older than the TTL, refresh it in the background. One refresh
 * runs at a time, so captures never land out of order. A capture that fell back to Orca's own env
 * never replaces a loaded profile.
 */
function createShellEnvironment(
  capture: (previous: ShellSnapshot | null) => Promise<LoginShellEnvironmentCapture>
): ShellEnvironment {
  let snapshot: ShellSnapshot | null = null
  let pendingEnvironment: Promise<NodeJS.ProcessEnv> | null = null
  const refresh = (): Promise<NodeJS.ProcessEnv> => {
    pendingEnvironment ??= capture(snapshot)
      .then((result) => {
        const capturedAt = Date.now()
        const profileLoaded = result.status === 'captured'
        // Over another fallback a fallback still carries a newer saved Windows PATH.
        snapshot =
          profileLoaded || !snapshot?.profileLoaded
            ? { env: result.env, capturedAt, profileLoaded }
            : { ...snapshot, capturedAt }
        return snapshot.env
      })
      .finally(() => {
        pendingEnvironment = null
      })
    return pendingEnvironment
  }
  // Why: start as soon as it exists so the first chat rarely waits for the profile.
  refresh().catch(() => {})
  return {
    resolve: () => {
      if (!snapshot) {
        return refresh()
      }
      if (isStale(snapshot)) {
        refresh().catch(() => {})
      }
      return Promise.resolve(snapshot.env)
    },
    refreshAfterMissingProgram: () => withinShellTimeout(refresh())
  }
}

// One per host, so launches, their misses and the create check all share a snapshot and a refresh.
let hostShell: ShellEnvironment | null = null

function hostShellEnvironment(): ShellEnvironment {
  hostShell ??= createShellEnvironment(captureHostShellEnvironment)
  return hostShell
}

export function resetHostShellEnvironmentForTests(): void {
  hostShell = null
}

/** Every agent's child env over the host's shell snapshot; an injected `resolveEnvironment` gets
 *  its own snapshot. Policy and overlays are re-read per acquisition. */
export function createStructuredAgentEnvironmentResolvers(
  sources: StructuredAgentEnvironmentSources
): {
  resolveCodexEnvironment: () => Promise<NodeJS.ProcessEnv>
  resolveClaudeInheritedEnv: () => Promise<Record<string, string>>
  /** The shared base every agent's child env starts from, before its own overlay. */
  resolveBaseEnvironment: () => Promise<Record<string, string>>
  refreshAfterMissingProgram: () => Promise<void>
} {
  const injected = sources.resolveEnvironment
  const shell = injected
    ? createShellEnvironment(async () => ({
        status: 'captured',
        env: await injected()
      }))
    : hostShellEnvironment()
  const resolveBase = async (): Promise<Record<string, string>> =>
    structuredAgentBaseEnvironment({
      shellEnv: await shell.resolve(),
      policy: sources.resolveShellEnvironmentPolicy?.() ?? nativeChatShellEnvironmentPolicy(null)
    })
  return {
    refreshAfterMissingProgram: shell.refreshAfterMissingProgram,
    resolveCodexEnvironment: async () => ({
      ...(await resolveBase()),
      ...(await sources.resolveLaunchEnv?.()),
      ...(await sources.resolveLaunchEnvOverlay?.()),
      ...sources.resolveCodexOverrides?.()
    }),
    resolveClaudeInheritedEnv: resolveBase,
    resolveBaseEnvironment: resolveBase
  }
}
