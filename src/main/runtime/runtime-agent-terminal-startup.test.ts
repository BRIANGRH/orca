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
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: with a supplied fact, or a caller-quoted non-Qoder command, the planner reads only getSettings.
  store: { getSettings: () => ({}) } as never,
  hostIdentity: 'host-1',
  toSessionOptions: () => undefined
}
const CMD: AgentLaunchRuntime = {
  platform: 'win32',
  remote: false,
  pty: { shellOverride: 'cmd.exe', terminalWindowsWslDistro: null }
}
const plan = (opts: TerminalCreateOptions, launchRuntime: AgentLaunchRuntime = CMD) =>
  resolveAgentTerminalCreateOptions(workspace, { ...opts, launchRuntime }, host)

// The host planner's inputs. Relied on by C2 (pane spawns run this plan), C3 and C7.
describe('host agent planner', () => {
  it("quotes for the fact's shell and hands that same fact to the spawn", async () => {
    const launch = await plan({ startupAgent: 'claude', agentArgs: '--model opus' })
    expect(launch.command).toBe('claude "--model" "opus"')
    expect(launch.launchRuntime).toBe(CMD)
    // A command the caller quoted itself keeps the spawn's own shell rule (C4 moves those callers).
    const own = await resolveAgentTerminalCreateOptions(
      workspace,
      { command: 'claude', launchAgent: 'claude' },
      host
    )
    expect(own.launchRuntime).toBeUndefined()
  })

  it('merges extra arguments and reports the request kind (C3 resume, C7 automations)', async () => {
    const launch = await plan({
      startupAgent: 'claude',
      agentArgs: null,
      extraAgentArgs: '--model opus',
      requestKind: 'resume'
    })
    expect(launch.command).toBe('claude "--model" "opus"')
    expect(launch.telemetry?.request_kind).toBe('resume')
  })

  it("keeps a long prompt on the command line under the window's rule (C3, C7)", async () => {
    const prompt = 'x'.repeat(600)
    const carried: boolean[] = []
    const opts = { startupAgent: 'claude' as const, startupPrompt: prompt }
    const onStartupPromptCarry = (value: boolean) => carried.push(value)
    expect((await plan({ ...opts, onStartupPromptCarry })).command).not.toContain(prompt)
    expect((await plan({ ...opts, promptCarry: 'argv', onStartupPromptCarry })).command).toContain(
      prompt
    )
    expect(carried).toEqual([false, true])
  })

  it('makes a promptless Codex wait for the shell only when asked (C8 deletes the choice)', async () => {
    expect((await plan({ startupAgent: 'codex' })).startupCommandDelivery).toBeUndefined()
    expect(
      (await plan({ startupAgent: 'codex', codexNoPromptShellWait: true })).startupCommandDelivery
    ).toBe('shell-ready')
  })

  it("rewrites Qoder once, probing where the fact's PTY runs (C2 skips the window copy)", async () => {
    vi.mocked(detectAgentCommandsOnHost).mockClear()
    const platform = process.platform
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    try {
      const launch = await plan(
        { startupAgent: 'qoder', agentArgs: null },
        {
          platform: 'linux',
          remote: false,
          pty: { shellOverride: 'wsl.exe', terminalWindowsWslDistro: 'Ubuntu' }
        }
      )
      expect(launch.command).toBe('qoder')
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: platform })
    }
    expect(detectAgentCommandsOnHost).toHaveBeenCalledTimes(1)
    expect(vi.mocked(detectAgentCommandsOnHost).mock.calls[0]?.[1]).toMatchObject({
      context: { wslDistro: 'Ubuntu' }
    })
  })
})
