import { AGENT_LAUNCH_TERMINAL_INPUTS_RUNTIME_CAPABILITY } from './agent-launch-runtime-capability'

export type AgentLaunchTerminalInputParams = {
  title?: string
  extraAgentArgs?: string
  requestKind?: string
  terminalOnly?: boolean
}

/**
 * The `agent.launch` terminal inputs a client may send to this host. An older host drops unknown
 * keys, so an input that changes what runs refuses here rather than launching something else; a
 * label (title, request kind) is just left off.
 */
export function agentLaunchTerminalInputsFor(
  hostCapabilities: readonly string[] | null | undefined,
  inputs: AgentLaunchTerminalInputParams
): AgentLaunchTerminalInputParams {
  if (hostCapabilities?.includes(AGENT_LAUNCH_TERMINAL_INPUTS_RUNTIME_CAPABILITY)) {
    return inputs
  }
  if (inputs.extraAgentArgs || inputs.terminalOnly) {
    throw new Error(
      'The Orca host for this workspace is too old to start this agent. Update Orca on that host and try again.'
    )
  }
  return {}
}
