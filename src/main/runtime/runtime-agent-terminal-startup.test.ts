import { describe, expect, it, vi } from 'vitest'
import type { AgentLaunchRuntime } from '../../shared/agent-launch-runtime'
import { detectAgentCommandsOnHost } from '../preflight/agent-detection'
import { resolveAgentTerminalCreateOptions } from './runtime-agent-terminal-startup'
import type { TerminalCreateOptions } from './runtime-terminal-contracts'

vi.mock('../preflight/agent-detection', () => ({
  detectAgentCommandsOnHost: vi.fn(async () => new Set(['qoder']))
}))

const workspace = { id: 'w', path: '/repo', connectionId: null, repo: null, folderWorkspace: null }
const host = {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: for a workspace with no repo or folder, the planner reads only getSettings.
  store: { getSettings: () => ({ terminalWindowsShell: 'cmd.exe' }) } as never,
  hostIdentity: 'host-1',
  toSessionOptions: () => undefined
}
const CMD: AgentLaunchRuntime = {
  platform: 'win32',
  pty: { shellOverride: 'cmd.exe', terminalWindowsWslDistro: null }
}
const plan = (opts: TerminalCreateOptions, launchRuntime: AgentLaunchRuntime = CMD) =>
  resolveAgentTerminalCreateOptions(workspace, { ...opts, launchRuntime }, host)
const onWindows = async <T>(run: () => Promise<T>): Promise<T> => {
  const platform = process.platform
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  try {
    return await run()
  } finally {
    Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  }
}

// The host planner's inputs. Relied on by C2, whose pane spawns run this plan.
describe('host agent planner', () => {
  it("quotes for the fact's shell and hands that same fact to the spawn", async () => {
    const launch = await onWindows(() =>
      resolveAgentTerminalCreateOptions(
        workspace,
        { startupAgent: 'claude', agentArgs: '--model opus' },
        host
      )
    )
    expect(launch.command).toBe('claude "--model" "opus"')
    expect(launch.launchRuntime).toEqual(CMD)
    // A command the caller quoted itself keeps the spawn's own shell rule (C4 moves those callers).
    const own = await resolveAgentTerminalCreateOptions(
      workspace,
      { command: 'claude', launchAgent: 'claude' },
      host
    )
    expect(own.launchRuntime).toBeUndefined()
  })

  it("rewrites Qoder once, probing where the fact's PTY runs (C2 skips the window copy)", async () => {
    vi.mocked(detectAgentCommandsOnHost).mockClear()
    const launch = await onWindows(() =>
      plan(
        { startupAgent: 'qoder', agentArgs: null },
        { platform: 'linux', pty: { shellOverride: 'wsl.exe', terminalWindowsWslDistro: 'Ubuntu' } }
      )
    )
    expect(launch.command).toBe('qoder')
    expect(detectAgentCommandsOnHost).toHaveBeenCalledTimes(1)
    expect(vi.mocked(detectAgentCommandsOnHost).mock.calls[0]?.[1]).toMatchObject({
      context: { wslDistro: 'Ubuntu' }
    })
  })
})
