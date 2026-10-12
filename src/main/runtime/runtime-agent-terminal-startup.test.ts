import { describe, expect, it, vi } from 'vitest'
import { detectAgentCommandsOnHost } from '../preflight/agent-detection'
import { resolveAgentTerminalCreateOptions } from './runtime-agent-terminal-startup'

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
    expect(launch.launchRuntime).toEqual({
      platform: 'win32',
      pty: { shellOverride: 'cmd.exe', terminalWindowsWslDistro: null }
    })
  })

  it("rewrites Qoder once, probing where the fact's PTY runs (C2 skips the window copy)", async () => {
    vi.mocked(detectAgentCommandsOnHost).mockClear()
    const launch = await onWindows(() =>
      resolveAgentTerminalCreateOptions(
        workspace,
        {
          startupAgent: 'qoder',
          agentArgs: null,
          launchRuntime: {
            platform: 'linux',
            pty: { shellOverride: 'wsl.exe', terminalWindowsWslDistro: 'Ubuntu' }
          }
        },
        host
      )
    )
    expect(launch.command).toBe('qoder')
    expect(detectAgentCommandsOnHost).toHaveBeenCalledTimes(1)
    expect(vi.mocked(detectAgentCommandsOnHost).mock.calls[0]?.[1]).toMatchObject({
      context: { wslDistro: 'Ubuntu' }
    })
  })
})
