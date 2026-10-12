import {
  agentLaunchQuotingShell,
  executionRuntimePlatform,
  remoteExecutionPlatform,
  type AgentLaunchRuntime
} from '../../shared/agent-launch-runtime'
import type { AgentStartupShell } from '../../shared/tui-agent-startup-shell'
import type { ProjectExecutionRuntimeResolution } from '../../shared/project-execution-runtime'
import {
  resolveLocalLaunchScopeRuntime,
  resolveLocalProjectRuntimeForWorktreeId,
  resolveLocalPtyOptions,
  type LaunchScopeRuntimeStore
} from '../local-project-runtime-resolution'
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
 * The runtime an agent launched here runs in: the window's rule, except where main's host had no
 * runtime for this scope and the rule answers "Windows host". There it keeps main's spawn in the
 * Terminal shell, since an explicit Windows-host default can't be told from the shipped one.
 * TEMPORARY (reachable only for folders): removed by the WSL-shell default decision, STA-10231.
 */
export function agentLaunchProjectRuntime(
  store: LaunchScopeRuntimeStore,
  scope: TerminalWorkspaceLaunchScope
): ProjectExecutionRuntimeResolution | undefined {
  const runtime = resolveLocalLaunchScopeRuntime(store, scope)
  return runtime?.status === 'resolved' &&
    runtime.runtime.kind === 'windows-host' &&
    !resolveLocalProjectRuntimeForWorktreeId(store, scope.id)
    ? undefined
    : runtime
}

/** The one runtime fact for an agent launched into this workspace. Throws, as the spawn would,
 *  when the workspace's runtime needs repair. */
export function resolveAgentLaunchRuntime(
  store: AgentLaunchRuntimeStore,
  scope: TerminalWorkspaceLaunchScope,
  requestedShellOverride: string | undefined
): AgentLaunchRuntime {
  if (scope.connectionId) {
    return {
      platform: remoteExecutionPlatform(scope.path),
      pty: { shellOverride: undefined, terminalWindowsWslDistro: null }
    }
  }
  const projectRuntime = agentLaunchProjectRuntime(store, scope)
  return {
    platform: executionRuntimePlatform(projectRuntime, scope.path, process.platform),
    pty: resolveLocalPtyOptions(store.getSettings(), projectRuntime, requestedShellOverride)
  }
}

/**
 * The fact for a startup agent, planned before its terminal is created. A runtime that needs repair
 * gives its error instead, so a worktree create goes on and the startup fails with that error as its
 * spawn would; that startup is quoted for the Settings shell.
 */
export function resolveStartupAgentLaunchRuntime(
  store: AgentLaunchRuntimeStore,
  scope: TerminalWorkspaceLaunchScope
): {
  platform: NodeJS.Platform
  shell: AgentStartupShell | undefined
  launchRuntime: AgentLaunchRuntime | Error
} {
  try {
    const launchRuntime = resolveAgentLaunchRuntime(store, scope, undefined)
    return {
      platform: launchRuntime.platform,
      shell: agentLaunchQuotingShell(launchRuntime),
      launchRuntime
    }
  } catch (error) {
    return {
      platform: agentLaunchPlatformForScope(store, scope),
      shell: undefined,
      launchRuntime: error instanceof Error ? error : new Error(String(error))
    }
  }
}
