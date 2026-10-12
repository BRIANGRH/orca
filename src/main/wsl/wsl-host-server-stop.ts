/**
 * Removing a WSL host ends what Orca runs in its distro: the terminals (through orcad's own
 * terminal RPC), then orcad and its terminal daemon through the managed decommission SSH hosts use
 * (`--complete-managed-stop` with `retireIdleDaemon`). The terminal census proves nothing is left
 * before the daemon is asked to retire, since a busy daemon keeps its sessions by design.
 */
import type { OrcadDecommissionResult } from '../../shared/orcad-decommission'
import { ORCAD_MANAGED_REMOTE_PORT } from '../../shared/orcad-managed-runtime'
import type { OrcadTerminalCensus } from '../../shared/orcad-terminal-census'
import type { RuntimeTerminalListResult } from '../../shared/runtime-terminal-contracts'
import type { WslHostServerStop } from '../../shared/wsl-host-types'
import type { OrcadHostTransport } from '../ssh/orcad-host-transport'
import { managedOrcadSlot } from '../ssh/orcad-managed-runtime-context'
import { resolveOrcadRemoteContext } from '../ssh/orcad-remote-context'
import { decommissionRemoteOrcad } from '../ssh/orcad-remote-decommission'
import type { WslOrcadHostTarget } from './wsl-orcad-host-target'

const CENSUS_ATTEMPTS = 20
const CENSUS_INTERVAL_MS = 250

export type WslHostServerStopSteps = {
  /** Ends every terminal orcad runs, through its own RPC. */
  endTerminals: () => Promise<void>
  census: () => Promise<OrcadTerminalCensus>
  /** After the bridge closed: liveness must not see this exit as a crash to recover. */
  closeBridge: () => Promise<void>
  decommission: (census: OrcadTerminalCensus) => Promise<OrcadDecommissionResult>
  sleep?: (ms: number) => Promise<void>
}

function partial(reason: string): WslHostServerStop {
  return { stopped: false, reason }
}

export async function stopWslHostServer(steps: WslHostServerStopSteps): Promise<WslHostServerStop> {
  const sleep = steps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  try {
    await steps.endTerminals()
  } catch (error) {
    await steps.closeBridge()
    return partial(`Orca couldn’t end the host’s terminals: ${errorMessage(error)}`)
  }
  // Shells take a moment to exit after their PTYs close; the census is the proof they did.
  let census = await steps.census()
  for (let attempt = 1; attempt < CENSUS_ATTEMPTS && census.liveSessions !== 0; attempt += 1) {
    await sleep(CENSUS_INTERVAL_MS)
    census = await steps.census()
  }
  await steps.closeBridge()
  if (census.liveSessions !== 0) {
    return partial(
      census.liveSessions === null
        ? 'The terminal daemon did not answer a session count, so Orca left it running.'
        : `${census.liveSessions} terminal${census.liveSessions === 1 ? '' : 's'} kept running, so Orca left the server running.`
    )
  }
  const result = await steps.decommission(census)
  if (result.outcome === 'refused') {
    return partial(result.reason)
  }
  return result.retirement === 'retired'
    ? { stopped: true }
    : partial('Orca’s server stopped, but its terminal daemon is still running.')
}

/**
 * How removal reaches the host's orcad: by environment id, through the same routed transport and
 * saved pairing every other call to the host uses (the bridge's raw pairing offer is not it).
 */
export type WslHostRuntimeAccess = {
  call: (environmentId: string, method: string, params: unknown) => Promise<unknown>
  census: (environmentId: string) => Promise<OrcadTerminalCensus>
}

function isTerminalList(value: unknown): value is Pick<RuntimeTerminalListResult, 'terminals'> {
  return (
    typeof value === 'object' && value !== null && Array.isArray(Reflect.get(value, 'terminals'))
  )
}

/** Ending terminals and counting what is left, both through the host's own orcad. */
export function wslHostRuntimeStopSteps(
  access: WslHostRuntimeAccess,
  environmentId: string
): Pick<WslHostServerStopSteps, 'endTerminals' | 'census'> {
  return {
    endTerminals: async () => {
      const list = await access.call(environmentId, 'terminal.list', { limit: 1000 })
      if (!isTerminalList(list)) {
        throw new Error('The host answered its terminal list in an unknown shape.')
      }
      for (const owner of new Set(list.terminals.map((terminal) => terminal.worktreeId))) {
        await access.call(environmentId, 'terminal.stop', { worktree: `id:${owner}` })
      }
    },
    census: () => access.census(environmentId)
  }
}

/** The managed decommission, over wsl.exe rather than the bridge (which is closed by then). */
export function decommissionWslHostOrcad(
  target: WslOrcadHostTarget,
  transport: OrcadHostTransport
): WslHostServerStopSteps['decommission'] {
  return async (census) => {
    const context = await resolveOrcadRemoteContext(target, transport)
    return decommissionRemoteOrcad({
      ...managedOrcadSlot(context, ORCAD_MANAGED_REMOTE_PORT),
      record: context.activationRecord,
      census
    })
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
