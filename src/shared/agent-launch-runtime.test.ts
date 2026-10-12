import { describe, expect, it } from 'vitest'
import { deriveAgentLaunchRuntime } from './agent-launch-runtime'
import type { ProjectExecutionRuntimeResolution } from './project-execution-runtime'

const WSL: ProjectExecutionRuntimeResolution = {
  status: 'resolved',
  runtime: {
    kind: 'wsl',
    hostPlatform: 'wsl',
    projectId: 'p',
    distro: 'Ubuntu',
    reason: 'project-override',
    cacheKey: 'p:wsl:Ubuntu'
  }
}
const WINDOWS_HOST: ProjectExecutionRuntimeResolution = {
  status: 'resolved',
  runtime: {
    kind: 'windows-host',
    hostPlatform: 'win32',
    projectId: 'p',
    reason: 'project-override',
    cacheKey: 'p:windows-host'
  }
}
const base = {
  hostPlatform: 'win32' as const,
  remote: false,
  workspacePath: 'C:\\repo',
  requestedShellOverride: undefined,
  settings: { terminalWindowsShell: 'cmd.exe' },
  sshLoginShell: undefined
}

// Relied on by C2: the pane's pty:spawn takes this object as is, for quoting and shell alike.
describe('the one runtime fact for an agent launch', () => {
  it('quotes a WSL runtime for Linux and starts it in that distro', () => {
    expect(deriveAgentLaunchRuntime({ ...base, projectRuntime: WSL })).toEqual({
      platform: 'linux',
      quotingShell: 'posix',
      ptyShellOverride: 'wsl.exe',
      wslDistro: 'Ubuntu'
    })
  })

  it('quotes for the Windows shell that runs, not a wsl.exe setting it replaced', () => {
    expect(
      deriveAgentLaunchRuntime({
        ...base,
        settings: { terminalWindowsShell: 'wsl.exe' },
        projectRuntime: WINDOWS_HOST
      })
    ).toMatchObject({
      platform: 'win32',
      quotingShell: 'powershell',
      ptyShellOverride: 'powershell.exe'
    })
  })

  it('leaves a remote host its own shell and quotes for its path', () => {
    expect(
      deriveAgentLaunchRuntime({
        ...base,
        remote: true,
        projectRuntime: undefined
      })
    ).toEqual({
      platform: 'win32',
      quotingShell: 'powershell',
      ptyShellOverride: undefined,
      wslDistro: null
    })
  })
})
