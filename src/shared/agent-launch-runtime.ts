import type { GlobalSettings } from './global-settings-types'
import type { ProjectExecutionRuntimeResolution } from './project-execution-runtime'
import { isWindowsAbsolutePathLike } from './cross-platform-path'
import { resolveLocalWindowsTerminalRuntimeOptions } from './local-windows-terminal-runtime'
import { resolveStartupShell, type AgentStartupShell } from './tui-agent-startup-shell'
import { resolveLocalWindowsAgentStartupShell } from './windows-terminal-shell'
import { isWslUncPath } from './wsl-paths'

/**
 * Where an agent launch runs, resolved once on its execution host: what its command is quoted for
 * and the shell its PTY is. Both come from here so they cannot disagree. In memory only.
 */
export type AgentLaunchRuntime = {
  /** The platform the command is quoted for: `linux` for a WSL runtime. */
  platform: NodeJS.Platform
  quotingShell: AgentStartupShell
  /** The provider's `shellOverride`; absent for a remote host, which picks its own shell. */
  ptyShellOverride: string | undefined
  /** The provider's `terminalWindowsWslDistro`. */
  wslDistro: string | null
}

/** A local workspace's platform: its project runtime, else a `\\wsl$` path is Linux, else the host. */
export function executionRuntimePlatform(
  projectRuntime: ProjectExecutionRuntimeResolution | undefined,
  workspacePath: string | null | undefined,
  hostPlatform: NodeJS.Platform
): NodeJS.Platform {
  if (projectRuntime?.status === 'repair-required') {
    return projectRuntime.repair.preferredRuntime.kind === 'wsl' ? 'linux' : hostPlatform
  }
  if (projectRuntime?.status === 'resolved') {
    return projectRuntime.runtime.kind === 'wsl' ? 'linux' : hostPlatform
  }
  return workspacePath && isWslUncPath(workspacePath) ? 'linux' : hostPlatform
}

/** A remote workspace is quoted for its own path's family; its host picks the shell. */
export function remoteExecutionPlatform(workspacePath: string): NodeJS.Platform {
  return isWindowsAbsolutePathLike(workspacePath) ? 'win32' : 'linux'
}

export function deriveAgentLaunchRuntime(args: {
  hostPlatform: NodeJS.Platform
  remote: boolean
  workspacePath: string
  projectRuntime: ProjectExecutionRuntimeResolution | undefined
  requestedShellOverride: string | undefined
  settings: Partial<
    Pick<
      GlobalSettings,
      'terminalWindowsShell' | 'terminalWindowsWslDistro' | 'terminalDefaultShell'
    >
  >
  /** The Windows shell that replaces a `wsl.exe` setting on a Windows-host runtime; absent is
   *  `powershell.exe`, as the window's tabs pick. */
  fallbackHostShell?: string
  sshLoginShell: string | undefined
}): AgentLaunchRuntime {
  if (args.remote) {
    const platform = remoteExecutionPlatform(args.workspacePath)
    return {
      platform,
      quotingShell: resolveStartupShell(platform),
      ptyShellOverride: undefined,
      wslDistro: null
    }
  }
  // The spawn's own formula; it throws for a runtime that needs repair, as the spawn would.
  const pty =
    args.hostPlatform === 'win32'
      ? resolveLocalWindowsTerminalRuntimeOptions({
          requestedShellOverride: args.requestedShellOverride,
          settings: args.settings,
          projectRuntime: args.projectRuntime,
          fallbackHostShell: args.fallbackHostShell,
          sshLoginShell: args.sshLoginShell
        })
      : {
          shellOverride:
            args.requestedShellOverride ?? (args.settings.terminalDefaultShell || undefined),
          terminalWindowsWslDistro: null
        }
  const platform = executionRuntimePlatform(
    args.projectRuntime,
    args.workspacePath,
    args.hostPlatform
  )
  return {
    platform,
    // Why from the PTY shell: quoting for a setting the spawn overrode types into the wrong shell.
    quotingShell: resolveStartupShell(
      platform,
      resolveLocalWindowsAgentStartupShell({
        platform,
        isRemote: false,
        terminalWindowsShell: pty.shellOverride
      })
    ),
    ptyShellOverride: pty.shellOverride,
    wslDistro: pty.terminalWindowsWslDistro
  }
}
