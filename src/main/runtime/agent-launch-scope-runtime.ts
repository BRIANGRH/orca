import type { Repo } from '../../shared/repo-types'
import {
  deriveAgentLaunchRuntime,
  executionRuntimePlatform,
  remoteExecutionPlatform,
  type AgentLaunchRuntime
} from '../../shared/agent-launch-runtime'
import { resolveStartupShell } from '../../shared/tui-agent-startup-shell'
import { resolveLocalWindowsAgentStartupShell } from '../../shared/windows-terminal-shell'
import { isWslUncPath } from '../../shared/wsl-paths'
import {
  resolveLocalLaunchScopeRuntime,
  resolveLocalProjectRuntimeForRepo,
  resolveLocalProjectRuntimeForWorktreeId,
  resolveLocalWorkspaceRuntime,
  type LaunchScopeRuntimeStore
} from '../local-project-runtime-resolution'
import { resolveManagedSshHostLoginShell } from '../pty/managed-ssh-host-login-shell'
import { getAgentLaunchPlatformForRepo } from './runtime-agent-launch-resolution'
import type { RuntimeStore } from './runtime-store-contract'
import type { TerminalWorkspaceLaunchScope } from './runtime-legacy-worker-terminal-recovery-types'

type AgentLaunchRuntimeStore = Omit<LaunchScopeRuntimeStore, 'getSettings'> &
  Pick<RuntimeStore, 'getSettings'>

/** The platform an agent for this repo is quoted for before any workspace exists, by the window's
 *  rule (`resolveRepoExecutionHostPlatform`). */
export function agentLaunchPlatformForRepo(
  store: LaunchScopeRuntimeStore,
  repo: Repo
): NodeJS.Platform {
  if (repo.connectionId) {
    return remoteExecutionPlatform(repo.path)
  }
  return executionRuntimePlatform(
    resolveLocalWorkspaceRuntime(store, repo, repo.path),
    repo.path,
    process.platform
  )
}

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

/** The one runtime fact for an agent launched into this workspace. Throws, as the spawn would,
 *  when the workspace's runtime needs repair. */
export function resolveAgentLaunchRuntime(
  store: AgentLaunchRuntimeStore,
  scope: TerminalWorkspaceLaunchScope,
  requestedShellOverride: string | undefined
): AgentLaunchRuntime {
  return deriveAgentLaunchRuntime({
    hostPlatform: process.platform,
    remote: Boolean(scope.connectionId),
    workspacePath: scope.path,
    projectRuntime: resolveLocalLaunchScopeRuntime(store, scope),
    requestedShellOverride,
    settings: store.getSettings(),
    sshLoginShell: resolveManagedSshHostLoginShell()
  })
}

/**
 * Main's quoting and shell rules from before the one fact, as one fact: kept only for the OpenCode
 * model hop (`createAgentSession`), which C2 deletes.
 */
export function resolvePreC1AgentLaunchRuntime(
  store: AgentLaunchRuntimeStore,
  scope: TerminalWorkspaceLaunchScope
): AgentLaunchRuntime {
  const settings = store.getSettings()
  const platform = scope.repo
    ? getAgentLaunchPlatformForRepo(
        scope.repo,
        scope.repo.connectionId ? undefined : resolveLocalProjectRuntimeForRepo(store, scope.repo)
      )
    : scope.connectionId
      ? remoteExecutionPlatform(scope.path)
      : isWslUncPath(scope.path)
        ? 'linux'
        : process.platform
  const pty = deriveAgentLaunchRuntime({
    hostPlatform: process.platform,
    remote: Boolean(scope.connectionId),
    workspacePath: scope.path,
    projectRuntime: resolveLocalProjectRuntimeForWorktreeId(store, scope.id),
    requestedShellOverride: undefined,
    settings,
    fallbackHostShell: process.env.COMSPEC || 'powershell.exe',
    sshLoginShell: resolveManagedSshHostLoginShell()
  })
  return {
    ...pty,
    platform,
    quotingShell: resolveStartupShell(
      platform,
      resolveLocalWindowsAgentStartupShell({
        platform,
        isRemote: Boolean(scope.connectionId),
        terminalWindowsShell: settings.terminalWindowsShell
      })
    )
  }
}
