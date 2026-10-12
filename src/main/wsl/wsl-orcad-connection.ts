/**
 * The desktop's connection to one WSL distro's orcad: deploy and launch (C4), the `wsl.exe` stdio
 * bridge listener, and orcad's pairing offer rewritten to that listener's loopback port. One per
 * distro; a relaunch that moved orcad's port moves the bridge with it. In memory only: the
 * deployment record (C7) persists what `onChange` reports.
 */
import { parsePairingCode } from '../../shared/pairing'
import { pairedRuntimeConnectionFromOffer } from '../../shared/paired-runtime-connection'
import type { ServeReadiness } from '../server/serve-readiness'
import type { OrcadHostTransport } from '../ssh/orcad-host-transport'
import {
  OrcadManagedIdentityError,
  verifyOrcadPairingIdentity,
  type OrcadTunnelIdentity
} from '../ssh/orcad-managed-tunnel-identity'
import { tunneledOrcadPairingCode } from '../ssh/orcad-tunneled-pairing'
import type { StartedPortForward } from '../ssh/ssh-port-forward-provider'
import type { WslDistroHolder } from './wsl-distro-holder'
import { wslDistroHolderKey } from './wsl-distro-holder-record'
import {
  defaultWslOrcadEnvironmentId,
  deployAndLaunchWslOrcad,
  type WslOrcadDeployOptions,
  type WslOrcadLaunch
} from './wsl-orcad-deploy'
import type { WslOrcadHostTarget } from './wsl-orcad-host-target'
import { createWslOrcadHostTransport } from './wsl-orcad-host-transport'
import {
  listenWslOrcadStdioBridge,
  type WslOrcadStdioBridgeOptions
} from './wsl-orcad-stdio-bridge'

export type WslOrcadConnection = {
  distro: string
  environmentId: string
  /** The loopback port on this machine the pairing offer points at. */
  localPort: number
  /** orcad's port inside the distro. */
  remotePort: number
  fullVersion: string
  /** orcad's pairing code, with its endpoint rewritten to `ws://127.0.0.1:<localPort>`. */
  pairingOffer: string
  close(): Promise<void>
}

type WslOrcadDeferredLaunch = Extract<WslOrcadLaunch, { outcome: 'deferred' }>

/** orcad installed an update it may not activate yet (live terminals); nothing is listening. */
export class WslOrcadLaunchDeferredError extends Error {
  constructor(readonly launch: WslOrcadDeferredLaunch) {
    super(launch.reason)
    this.name = 'WslOrcadLaunchDeferredError'
  }
}

export class WslOrcadConnectionSupersededError extends Error {
  constructor(distro: string) {
    super(`The connection to the WSL distro ${distro} was closed while it was being opened.`)
    this.name = 'WslOrcadConnectionSupersededError'
  }
}

export type WslOrcadConnectOptions = {
  environmentId?: string
  label?: string
  /** Rebinds a port a persisted pairing offer already names; 0 or absent picks a free one. */
  localPort?: number
  force?: boolean
  signal?: AbortSignal
}

export type WslOrcadConnectionDependencies = {
  holder?: WslDistroHolder
  deployAndLaunch?: (distro: string, options: WslOrcadDeployOptions) => Promise<WslOrcadLaunch>
  createTransport?: (target: WslOrcadHostTarget) => OrcadHostTransport
  listen?: (
    transport: OrcadHostTransport,
    options: WslOrcadStdioBridgeOptions
  ) => Promise<StartedPortForward>
  verifyIdentity?: (pairingOffer: string, readiness: ServeReadiness) => Promise<OrcadTunnelIdentity>
  /** A connection (re)opened or its offer changed; null once it closed. */
  onChange?: (distro: string, connection: WslOrcadConnection | null) => void
}

type ActiveWslOrcadConnection = {
  connection: WslOrcadConnection
  forward: StartedPortForward
}

export class WslOrcadConnectionManager {
  private readonly active = new Map<string, ActiveWslOrcadConnection>()
  private readonly inFlight = new Map<string, Promise<WslOrcadConnection>>()
  private readonly generations = new Map<string, number>()

  constructor(private readonly dependencies: WslOrcadConnectionDependencies = {}) {}

  /** Joins a connect already running for this distro rather than racing a second bridge. */
  ensure(distro: string, options: WslOrcadConnectOptions = {}): Promise<WslOrcadConnection> {
    const name = distro.trim()
    if (!name) {
      return Promise.reject(new Error('A WSL distro name is required'))
    }
    const key = wslDistroHolderKey(name)
    const pending = this.inFlight.get(key)
    if (pending) {
      return pending
    }
    const operation = this.connect(name, key, options).finally(() => {
      if (this.inFlight.get(key) === operation) {
        this.inFlight.delete(key)
      }
    })
    this.inFlight.set(key, operation)
    return operation
  }

  get(distro: string): WslOrcadConnection | null {
    return this.active.get(wslDistroHolderKey(distro))?.connection ?? null
  }

  list(): WslOrcadConnection[] {
    return [...this.active.values()].map((entry) => entry.connection)
  }

  async close(distro: string): Promise<void> {
    const key = wslDistroHolderKey(distro)
    this.generations.set(key, this.generation(key) + 1)
    const entry = this.active.get(key)
    if (!entry) {
      return
    }
    this.active.delete(key)
    await entry.forward.close()
    this.dependencies.onChange?.(entry.connection.distro, null)
  }

  async dispose(): Promise<void> {
    const keys = new Set([...this.active.keys(), ...this.inFlight.keys()])
    await Promise.all([...keys].map((key) => this.close(key)))
  }

  private generation(key: string): number {
    return this.generations.get(key) ?? 0
  }

  private async connect(
    distro: string,
    key: string,
    options: WslOrcadConnectOptions
  ): Promise<WslOrcadConnection> {
    const generation = this.generation(key)
    const environmentId = options.environmentId ?? defaultWslOrcadEnvironmentId(distro)
    const label = options.label ?? distro
    const transport = (this.dependencies.createTransport ?? defaultTransport)({
      kind: 'wsl',
      id: environmentId,
      distro,
      label
    })
    // Every call relaunches a stopped orcad, so a distro restart is recovered here.
    const launch = await (this.dependencies.deployAndLaunch ?? deployAndLaunchWslOrcad)(distro, {
      environmentId,
      label,
      force: options.force,
      signal: options.signal,
      holder: this.dependencies.holder,
      createTransport: () => transport
    })
    if (launch.outcome === 'deferred') {
      throw new WslOrcadLaunchDeferredError(launch)
    }
    if (this.generation(key) !== generation) {
      throw new WslOrcadConnectionSupersededError(distro)
    }
    const current = this.active.get(key)
    if (
      current &&
      current.connection.remotePort === launch.port &&
      current.connection.environmentId === environmentId
    ) {
      return this.refreshOffer(key, current, launch)
    }
    // orcad moved ports (or this is the first connect): the old bridge dials a dead port.
    const preferredLocalPort = current?.connection.localPort ?? options.localPort ?? 0
    if (current) {
      this.active.delete(key)
      await current.forward.close()
      this.dependencies.onChange?.(distro, null)
    }
    const forward = await this.listen(transport, {
      environmentId,
      remotePort: launch.port,
      localPort: preferredLocalPort,
      label: `Orca server in WSL: ${label}`
    })
    try {
      if (this.generation(key) !== generation) {
        throw new WslOrcadConnectionSupersededError(distro)
      }
      const pairingOffer = tunneledOrcadPairingCode(launch.readiness, forward.entry.localPort)
      const identity = await (this.dependencies.verifyIdentity ?? verifyWslOrcadIdentity)(
        pairingOffer,
        launch.readiness
      )
      if (identity.verdict === 'foreign') {
        throw new OrcadManagedIdentityError(launch.port, identity.detail)
      }
      if (identity.verdict === 'unreachable') {
        // Why not fail: a server that is still starting is not a wrong server.
        console.warn(`[wsl] Orca server in ${distro} did not answer its bridge: ${identity.detail}`)
      }
      if (this.generation(key) !== generation) {
        throw new WslOrcadConnectionSupersededError(distro)
      }
      const entry: ActiveWslOrcadConnection = {
        forward,
        connection: {
          distro,
          environmentId,
          localPort: forward.entry.localPort,
          remotePort: launch.port,
          fullVersion: launch.fullVersion,
          pairingOffer,
          close: () => this.closeEntry(key, entry)
        }
      }
      this.active.set(key, entry)
      this.dependencies.onChange?.(distro, entry.connection)
      return entry.connection
    } catch (error) {
      await forward.close()
      throw error
    }
  }

  private refreshOffer(
    key: string,
    entry: ActiveWslOrcadConnection,
    launch: Extract<WslOrcadLaunch, { outcome: 'ready' }>
  ): WslOrcadConnection {
    const pairingOffer = tunneledOrcadPairingCode(launch.readiness, entry.connection.localPort)
    if (
      pairingOffer === entry.connection.pairingOffer &&
      launch.fullVersion === entry.connection.fullVersion
    ) {
      return entry.connection
    }
    entry.connection = { ...entry.connection, pairingOffer, fullVersion: launch.fullVersion }
    this.active.set(key, entry)
    this.dependencies.onChange?.(entry.connection.distro, entry.connection)
    return entry.connection
  }

  /** A persisted local port may be taken by now; a free one beats no connection. */
  private async listen(
    transport: OrcadHostTransport,
    options: WslOrcadStdioBridgeOptions
  ): Promise<StartedPortForward> {
    const listen = this.dependencies.listen ?? listenWslOrcadStdioBridge
    try {
      return await listen(transport, options)
    } catch (error) {
      if (options.localPort === 0) {
        throw error
      }
      console.warn(
        `[wsl] Could not rebind local port ${options.localPort}; picking another:`,
        error instanceof Error ? error.message : error
      )
      return listen(transport, { ...options, localPort: 0 })
    }
  }

  private async closeEntry(key: string, entry: ActiveWslOrcadConnection): Promise<void> {
    if (this.active.get(key) === entry) {
      await this.close(key)
    }
  }
}

async function verifyWslOrcadIdentity(
  pairingOffer: string,
  readiness: ServeReadiness
): Promise<OrcadTunnelIdentity> {
  const offer = parsePairingCode(pairingOffer)
  return offer
    ? verifyOrcadPairingIdentity(pairedRuntimeConnectionFromOffer(offer), {
        runtimeId: readiness.runtimeId || null
      })
    : { verdict: 'foreign', detail: 'The Orca server in WSL published an invalid pairing offer.' }
}

function defaultTransport(target: WslOrcadHostTarget): OrcadHostTransport {
  return createWslOrcadHostTransport({ target })
}
