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
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the planner reads only getSettings when the fact is supplied.
  store: { getSettings: () => ({}) } as never,
  hostIdentity: 'host-1',
  toSessionOptions: () => undefined
}
const CMD: AgentLaunchRuntime = {
  platform: 'win32',
  quotingShell: 'cmd',
  ptyShellOverride: 'cmd.exe',
  wslDistro: null
}
const plan = (opts: TerminalCreateOptions, launchRuntime: AgentLaunchRuntime = CMD) =>
  resolveAgentTerminalCreateOptions(workspace, { ...opts, launchRuntime }, host)

// The host planner's inputs. Relied on by C2 (pane spawns run this plan), C3 and C7.
describe('host agent planner', () => {
  it("quotes for the fact's shell and hands that same fact to the spawn", async () => {
    const launch = await plan({ startupAgent: 'claude', agentArgs: '--model opus' })
    expect(launch.command).toBe('claude "--model" "opus"')
    expect(launch.launchRuntime).toBe(CMD)
    // A caller that built its own agent command still gets the host's fact for its spawn.
    const own = await resolveAgentTerminalCreateOptions(
      workspace,
      { command: 'claude', launchAgent: 'claude' },
      host
    )
    expect(own.launchRuntime).toMatchObject({ platform: process.platform, wslDistro: null })
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
    const launch = await plan(
      { startupAgent: 'qoder', agentArgs: null },
      { platform: 'linux', quotingShell: 'posix', ptyShellOverride: 'wsl.exe', wslDistro: 'Ubuntu' }
    )
    expect(launch.command).toBe('qoder')
    expect(detectAgentCommandsOnHost).toHaveBeenCalledTimes(1)
    expect(vi.mocked(detectAgentCommandsOnHost).mock.calls[0]?.[1]).toMatchObject({
      context: { wslDistro: 'Ubuntu', wslDefault: true }
    })
  })
})
