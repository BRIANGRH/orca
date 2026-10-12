import type { Repo } from '../../shared/repo-types'
import {
  deriveAgentLaunchRuntime,
  executionRuntimePlatform,
  remoteExecutionPlatform,
  type AgentLaunchRuntime
} from '../../shared/agent-launch-runtime'
import { getRepoSshConnectionId } from '../../shared/execution-host'
import {
  resolveLocalLaunchScopeRuntime,
  resolveLocalProjectRuntimeForWorktreeId,
  type LaunchScopeRuntimeStore
} from '../local-project-runtime-resolution'
import { isWslShellName } from '../../shared/local-windows-terminal-runtime'
import { resolveManagedSshHostLoginShell } from '../pty/managed-ssh-host-login-shell'
import type { RuntimeStore } from './runtime-store-contract'
import type { TerminalWorkspaceLaunchScope } from './runtime-legacy-worker-terminal-recovery-types'

type AgentLaunchRuntimeStore = Omit<LaunchScopeRuntimeStore, 'getSettings'> &
  Pick<RuntimeStore, 'getSettings'>

/** The platform an agent in this workspace is quoted for; never throws, unlike the full fact. */
export function agentLaunchPlatformForScope(
  store: LaunchScopeRuntimeStore,
  scope: TerminalWorkspaceLaunchScope
): NodeJS.Platform {
  return scope.connectionId
    ? remoteExecutionPlatform(scope.path)
    : executionRuntimePlatform(
        resolveLocalLaunchScopeRuntime(store, scope),
        scope.path,
        process.platform
      )
}

/**
 * TEMPORARY, removed by C8. `host-legacy` keeps today's host outcome for a Windows scope with no
 * project runtime of its own whose global default is the Windows host: a `wsl.exe` Terminal shell
 * still runs it in WSL. An explicit "Windows host" default cannot yet be told apart from the
 * shipped one. `window` is the "+" button's rule.
 */
export type WslShellRule = 'host-legacy' | 'window'

/** The one runtime fact for an agent launched into this workspace. Throws, as the spawn would,
 *  when the workspace's runtime needs repair. */
export function resolveAgentLaunchRuntime(
  store: AgentLaunchRuntimeStore,
  scope: TerminalWorkspaceLaunchScope,
  requestedShellOverride: string | undefined,
  wslShellRule: WslShellRule
): AgentLaunchRuntime {
  const settings = store.getSettings()
  const projectRuntime = resolveLocalLaunchScopeRuntime(store, scope)
  const keepsWslShell =
    wslShellRule === 'host-legacy' &&
    process.platform === 'win32' &&
    projectRuntime?.status === 'resolved' &&
    projectRuntime.runtime.kind === 'windows-host' &&
    projectRuntime.runtime.reason === 'global-default' &&
    isWslShellName(settings.terminalWindowsShell) &&
    !resolveLocalProjectRuntimeForWorktreeId(store, scope.id)
  return deriveAgentLaunchRuntime({
    hostPlatform: process.platform,
    remote: Boolean(scope.connectionId),
    workspacePath: scope.path,
    // With no runtime, the spawn runs the Terminal shell, as main's host did for these scopes.
    projectRuntime: keepsWslShell ? undefined : projectRuntime,
    requestedShellOverride,
    settings,
    sshLoginShell: resolveManagedSshHostLoginShell()
  })
}

/**
 * The fact for an agent a new workspace of this repo starts, built before the workspace exists. A
 * runtime that needs repair returns its error with the platform to quote for, so the create goes on
 * and the startup fails with that error as its spawn would.
 */
export function resolveRepoAgentLaunchRuntime(
  store: AgentLaunchRuntimeStore,
  repo: Repo
): AgentLaunchRuntime | { platform: NodeJS.Platform; repairError: Error } {
  const scope = {
    id: repo.id,
    path: repo.path,
    connectionId: getRepoSshConnectionId(repo),
    repo,
    folderWorkspace: null
  }
  try {
    return resolveAgentLaunchRuntime(store, scope, undefined, 'host-legacy')
  } catch (error) {
    return {
      platform: agentLaunchPlatformForScope(store, scope),
      repairError: error instanceof Error ? error : new Error(String(error))
    }
  }
}
