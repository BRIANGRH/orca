import type { GlobalSettings } from './global-settings-types'
import type { ProjectExecutionRuntimeResolution } from './project-execution-runtime'
import { isWindowsAbsolutePathLike } from './cross-platform-path'
import {
  resolveLocalWindowsTerminalRuntimeOptions,
  type LocalWindowsTerminalRuntimeOptions
} from './local-windows-terminal-runtime'
import { resolveStartupShell, type AgentStartupShell } from './tui-agent-startup-shell'
import { resolveLocalWindowsAgentStartupShell } from './windows-terminal-shell'
import { isWslUncPath } from './wsl-paths'

/**
 * Where an agent launch runs, resolved once on its execution host: the platform its command is
 * quoted for and its PTY's shell. The quoting shell is derived from both, so the command is always
 * quoted for the shell it is typed into. In memory only.
 */
export type AgentLaunchRuntime = {
  /** `linux` for a WSL runtime. */
  platform: NodeJS.Platform
  remote: boolean
  /** The spawn's own PTY options; empty for a remote host, which picks its own shell. */
  pty: LocalWindowsTerminalRuntimeOptions
}

export function agentLaunchQuotingShell(runtime: AgentLaunchRuntime): AgentStartupShell {
  return resolveStartupShell(
    runtime.platform,
    resolveLocalWindowsAgentStartupShell({
      platform: runtime.platform,
      isRemote: runtime.remote,
      terminalWindowsShell: runtime.pty.shellOverride
    })
  )
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

type LocalPtyInputs = {
  hostPlatform: NodeJS.Platform
  requestedShellOverride: string | undefined
  settings:
    | Partial<
        Pick<
          GlobalSettings,
          'terminalWindowsShell' | 'terminalWindowsWslDistro' | 'terminalDefaultShell'
        >
      >
    | undefined
  projectRuntime: ProjectExecutionRuntimeResolution | undefined
  /** The Windows shell that replaces a `wsl.exe` setting on a Windows-host runtime; absent is
   *  `powershell.exe`, as the window's tabs pick. */
  fallbackHostShell?: string
  sshLoginShell: string | undefined
}

/** A local PTY's shell and distro. Throws for a runtime that needs repair. */
export function resolveLocalPtyRuntimeOptions(
  args: LocalPtyInputs
): LocalWindowsTerminalRuntimeOptions {
  return args.hostPlatform === 'win32'
    ? resolveLocalWindowsTerminalRuntimeOptions({
        requestedShellOverride: args.requestedShellOverride,
        settings: args.settings,
        projectRuntime: args.projectRuntime,
        fallbackHostShell: args.fallbackHostShell,
        sshLoginShell: args.sshLoginShell
      })
    : {
        shellOverride:
          args.requestedShellOverride ?? (args.settings?.terminalDefaultShell || undefined),
        terminalWindowsWslDistro: null
      }
}

export function deriveAgentLaunchRuntime(
  args: LocalPtyInputs & { remote: boolean; workspacePath: string }
): AgentLaunchRuntime {
  if (args.remote) {
    return {
      platform: remoteExecutionPlatform(args.workspacePath),
      remote: true,
      pty: { shellOverride: undefined, terminalWindowsWslDistro: null }
    }
  }
  return {
    platform: executionRuntimePlatform(args.projectRuntime, args.workspacePath, args.hostPlatform),
    remote: false,
    pty: resolveLocalPtyRuntimeOptions(args)
  }
}
