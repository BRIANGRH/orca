/**
 * Removing a WSL host ends what Orca runs in its distro: the terminals (through orcad's own
 * terminal RPC), then orcad and its terminal daemon through the managed decommission SSH hosts use
 * (`--complete-managed-stop` with `retireIdleDaemon`). The terminal census proves nothing is left
 * before the daemon is asked to retire, since a busy daemon keeps its sessions by design.
 */
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../shared/electron-remote-runtime-client-capabilities'
import type { OrcadDecommissionResult } from '../../shared/orcad-decommission'
import { ORCAD_MANAGED_REMOTE_PORT } from '../../shared/orcad-managed-runtime'
import type { OrcadTerminalCensus } from '../../shared/orcad-terminal-census'
import { pairedRuntimeConnectionFromOffer } from '../../shared/paired-runtime-connection'
import { parsePairingCode } from '../../shared/pairing'
import { sendRemoteRuntimeRequest } from '../../shared/remote-runtime-client'
import type { RuntimeTerminalListResult } from '../../shared/runtime-terminal-contracts'
import type { WslHostServerStop } from '../../shared/wsl-host-types'
import type { OrcadHostTransport } from '../ssh/orcad-host-transport'
import { managedOrcadSlot } from '../ssh/orcad-managed-runtime-context'
import { resolveOrcadRemoteContext } from '../ssh/orcad-remote-context'
import { decommissionRemoteOrcad } from '../ssh/orcad-remote-decommission'
import { requestOrcadTerminalCensus } from '../ssh/orcad-terminal-census-client'
import type { WslOrcadConnection } from './wsl-orcad-connection'
import type { WslOrcadHostTarget } from './wsl-orcad-host-target'

const RPC_TIMEOUT_MS = 15_000
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

async function callRuntime<T>(connection: WslOrcadConnection, method: string, params: unknown) {
  const offer = parsePairingCode(connection.pairingOffer)
  if (!offer) {
    throw new Error('The WSL host has no valid pairing.')
  }
  const response = await sendRemoteRuntimeRequest<T>(
    pairedRuntimeConnectionFromOffer(offer),
    method,
    params,
    RPC_TIMEOUT_MS,
    undefined,
    undefined,
    ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES
  )
  if (!response.ok) {
    throw new Error(response.error.message)
  }
  return response.result
}

/** The production steps for a connected host. */
export function wslHostServerStopSteps(args: {
  connection: WslOrcadConnection
  target: WslOrcadHostTarget
  transport: OrcadHostTransport
  closeBridge: () => Promise<void>
}): WslHostServerStopSteps {
  const { connection } = args
  return {
    endTerminals: async () => {
      const list = await callRuntime<RuntimeTerminalListResult>(connection, 'terminal.list', {
        limit: 1000
      })
      for (const worktreeId of new Set(list.terminals.map((terminal) => terminal.worktreeId))) {
        await callRuntime(connection, 'terminal.stop', { worktree: `id:${worktreeId}` })
      }
    },
    census: async () => {
      const offer = parsePairingCode(connection.pairingOffer)
      return offer
        ? requestOrcadTerminalCensus(pairedRuntimeConnectionFromOffer(offer), 0)
        : { liveSessions: null, startedSinceActivation: null, daemonProtocolVersion: null }
    },
    closeBridge: args.closeBridge,
    decommission: async (census) => {
      const context = await resolveOrcadRemoteContext(args.target, args.transport)
      return decommissionRemoteOrcad({
        ...managedOrcadSlot(context, ORCAD_MANAGED_REMOTE_PORT),
        record: context.activationRecord,
        census
      })
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
