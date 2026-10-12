import { describe, expect, it } from 'vitest'
import { agentLaunchTerminalInputsFor } from './agent-launch-terminal-inputs'
import { AGENT_LAUNCH_TERMINAL_INPUTS_RUNTIME_CAPABILITY } from './agent-launch-runtime-capability'
import { AgentLaunch } from './rpc-contract/agent-launch-params'

const INPUTS = {
  title: 'Fix',
  requestKind: 'resume',
  extraAgentArgs: '--verbose',
  terminalOnly: true
}

// Relied on by C2, C3 and C7, the first producers that send these fields.
describe('agent.launch terminal inputs across versions', () => {
  it('sends all of them to a host that reads them', () => {
    expect(
      agentLaunchTerminalInputsFor([AGENT_LAUNCH_TERMINAL_INPUTS_RUNTIME_CAPABILITY], INPUTS)
    ).toEqual(INPUTS)
  })

  it('drops labels for an older host and refuses inputs it would silently ignore', () => {
    expect(agentLaunchTerminalInputsFor([], { title: 'Fix', requestKind: 'resume' })).toEqual({})
    expect(() => agentLaunchTerminalInputsFor([], { extraAgentArgs: '--verbose' })).toThrow(
      /too old/
    )
    expect(() => agentLaunchTerminalInputsFor(undefined, { terminalOnly: true })).toThrow(/too old/)
  })

  it("parses an older client's launch exactly as before", () => {
    const params = { agent: 'claude', target: { kind: 'existing', worktree: 'id:w' } }
    expect(AgentLaunch.parse(params)).toEqual(params)
  })
})
