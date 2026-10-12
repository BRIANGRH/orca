/**
 * WSL distros as hosts (WSL-via-orcad C7): add and remove them, persist what each connection
 * reports, and connect only for the user. A stopped distro boots on an explicit add or connect,
 * or while a project or terminal the user has open needs it; never for background work.
 */
import { listEnvironments } from '../../shared/runtime-environment-store'
import {
  addWslHostEnvironment,
  refreshWslHostPairing,
  removeWslHostEnvironment
} from '../../shared/runtime-environment-wsl-host-store'
import {
  readWslHostDeployments,
  type WslHostDeploymentRecord
} from '../../shared/wsl-host-deployment-store'
import {
  wslHostEnvironmentLabel,
  type WslHostAddResult,
  type WslHostDistro,
  type WslHostStatus
} from '../../shared/wsl-host-types'
import { OrcadHostUnsupportedError } from '../ssh/orcad-host-unavailable'
import type { WslHostDistroCandidate } from './wsl-host-distro-list'
import { findServerSharingWslOrcad } from './wsl-host-ssh-orcad-conflict'
import { wslDistroHolderKey } from './wsl-distro-holder-record'
import {
  admitWslHostDistro,
  sameWslDistro,
  WSL_HOSTS_DISABLED_MESSAGE
} from './wsl-host-add-admission'
import { WslOrcadLaunchDeferredError, type WslOrcadConnection } from './wsl-orcad-connection'
import type { WslOrcadConnectionStatus } from './wsl-orcad-connection-status'
import { defaultWslOrcadEnvironmentId } from './wsl-orcad-deploy'

/** The WSL side the service drives: C3 holder, C5 connections, C6 liveness (or an e2e fake). */
export type WslHostConnector = {
  listDistros(): Promise<WslHostDistroCandidate[]>
  /** Runs in the distro, so it boots a stopped one: only after the user chose to. */
  readOrcadPublicKey(distro: string): Promise<string | null>
  /** User-initiated; may boot the distro. */
  connect(distro: string): Promise<WslOrcadConnection>
  get(distro: string): WslOrcadConnection | null
  disconnect(distro: string): Promise<void>
  /** Ends orcad in a running distro; never boots one. */
  stopServer(distro: string, pid: number): Promise<void>
  releaseHolder(distro: string): Promise<void>
  adoptHolders(): Promise<void>
  dispose(): Promise<void>
}

export type WslHostServiceDependencies = {
  userDataPath: () => string
  isEnabled: () => boolean
  publish: (status: WslHostStatus) => void
  /** The environment's pairing changed: transports that authenticate with the old one retire. */
  pairingChanged: (environmentId: string) => void
  /** A connection came up: verify the server now rather than on the status owner's backoff. */
  ready: (environmentId: string) => void
  removed: (environmentId: string) => Promise<void> | void
}

export class WslHostService {
  private connector: WslHostConnector | null = null
  private readonly statuses = new Map<string, WslHostStatus>()
  private readonly adding = new Map<string, Promise<WslHostAddResult>>()
  private visible = new Set<string>()

  constructor(private readonly deps: WslHostServiceDependencies) {}

  /** Two-phase so the connector's `onChange` can call back into this service. */
  attach(connector: WslHostConnector): void {
    this.connector = connector
  }

  private get wsl(): WslHostConnector {
    if (!this.connector) {
      throw new Error('WSL hosts are not available on this computer.')
    }
    return this.connector
  }

  /** C5's `onChange`: persist what moved, then tell the UI. */
  handleConnectionChange(
    distro: string,
    connection: WslOrcadConnection | null,
    status: WslOrcadConnectionStatus
  ): void {
    const record = this.recordForDistro(distro)
    if (!record) {
      return
    }
    if (connection) {
      try {
        const { pairingChanged } = refreshWslHostPairing(
          this.deps.userDataPath(),
          record.environmentId,
          {
            pairingCode: connection.pairingOffer,
            localPort: connection.localPort,
            remotePort: connection.remotePort
          }
        )
        if (pairingChanged) {
          this.deps.pairingChanged(record.environmentId)
        }
      } catch (error) {
        console.warn(`[wsl-hosts] Could not save the new pairing for ${distro}:`, error)
      }
    }
    this.setStatus(record, status)
    if (status.state === 'ready' && connection) {
      this.deps.ready(record.environmentId)
    }
  }

  getStatuses(): WslHostStatus[] {
    return [...this.statuses.values()]
  }

  async listDistros(): Promise<WslHostDistro[]> {
    const records = this.records()
    const candidates = await this.wsl.listDistros()
    return candidates.map(({ id: _id, ...distro }) => ({
      ...distro,
      environmentId:
        records.find((record) => sameWslDistro(record.distro, distro.name))?.environmentId ?? null
    }))
  }

  add(args: { distro: string; startIfStopped?: boolean }): Promise<WslHostAddResult> {
    const key = wslDistroHolderKey(args.distro)
    const pending = this.adding.get(key)
    if (pending) {
      return pending
    }
    const operation = this.addOnce(args).finally(() => this.adding.delete(key))
    this.adding.set(key, operation)
    return operation
  }

  async remove(environmentId: string): Promise<void> {
    const record = this.recordForEnvironment(environmentId)
    if (!record) {
      throw new Error('This server is not a WSL host.')
    }
    const connector = this.connector
    if (connector) {
      const pid = connector.get(record.distro)?.pid ?? null
      await connector.disconnect(record.distro)
      // Only a connected server is stopped now; booting a stopped distro to stop it would be absurd.
      if (pid !== null) {
        await connector.stopServer(record.distro, pid).catch((error: unknown) => {
          console.warn(`[wsl-hosts] Could not stop the Orca server in ${record.distro}:`, error)
        })
      }
      // Without its holder the distro idles out, and any server still in it with it.
      await connector.releaseHolder(record.distro)
    }
    removeWslHostEnvironment(this.deps.userDataPath(), environmentId)
    this.statuses.delete(environmentId)
    this.visible.delete(environmentId)
    await this.deps.removed(environmentId)
  }

  /** The user asked for this host: may boot its distro. */
  async connect(environmentId: string): Promise<void> {
    const record = this.recordForEnvironment(environmentId)
    if (!record) {
      throw new Error('This server is not a WSL host.')
    }
    if (!this.deps.isEnabled()) {
      throw new Error(WSL_HOSTS_DISABLED_MESSAGE)
    }
    await this.wsl.connect(record.distro)
  }

  /** Before a call to a WSL host: connect only when an open project or terminal needs it. */
  async ensureForRuntimeCall(environmentId: string): Promise<void> {
    const record = this.recordForEnvironment(environmentId)
    if (!record || !this.connector || !this.deps.isEnabled()) {
      return
    }
    if (this.connector.get(record.distro) || !this.visible.has(environmentId)) {
      return
    }
    await this.connector.connect(record.distro)
  }

  setVisibleWork(environmentIds: readonly string[]): void {
    const previous = this.visible
    this.visible = new Set(environmentIds)
    if (!this.connector || !this.deps.isEnabled()) {
      return
    }
    for (const environmentId of this.visible) {
      if (previous.has(environmentId)) {
        continue
      }
      const record = this.recordForEnvironment(environmentId)
      if (record && !this.connector.get(record.distro)) {
        this.connector.connect(record.distro).catch((error: unknown) => {
          console.warn(`[wsl-hosts] Could not connect to ${record.distro}:`, error)
        })
      }
    }
  }

  hasUserVisibleWork(distro: string): boolean {
    const record = this.recordForDistro(distro)
    return record ? this.visible.has(record.environmentId) : false
  }

  /** Startup: keep the holders a previous run left, without booting anything. */
  async start(): Promise<void> {
    if (!this.connector || !this.deps.isEnabled() || this.records().length === 0) {
      return
    }
    await this.connector.adoptHolders()
  }

  async dispose(): Promise<void> {
    await this.connector?.dispose()
  }

  private async addOnce(args: {
    distro: string
    startIfStopped?: boolean
  }): Promise<WslHostAddResult> {
    if (!this.deps.isEnabled()) {
      return { ok: false, kind: 'disabled', message: WSL_HOSTS_DISABLED_MESSAGE }
    }
    const admission = admitWslHostDistro({
      requested: args.distro,
      candidates: await this.wsl.listDistros(),
      alreadyAdded: (name) => this.recordForDistro(name) !== null,
      startIfStopped: args.startIfStopped === true
    })
    if (!('distro' in admission)) {
      return admission
    }
    const { distro } = admission
    const userDataPath = this.deps.userDataPath()
    try {
      const sharing = findServerSharingWslOrcad(
        listEnvironments(userDataPath),
        await this.wsl.readOrcadPublicKey(distro.name)
      )
      if (sharing) {
        return {
          ok: false,
          kind: 'ssh-managed',
          message: `${distro.name} already runs the Orca server for “${sharing.name}”, which this computer reaches over SSH. Remove that server first; moving it to a WSL host isn’t supported yet.`
        }
      }
    } catch (error) {
      return { ok: false, kind: 'failed', message: errorMessage(error) }
    }
    const environmentId = defaultWslOrcadEnvironmentId(distro.name)
    let connection: WslOrcadConnection
    try {
      connection = await this.wsl.connect(distro.name)
    } catch (error) {
      if (error instanceof WslOrcadLaunchDeferredError) {
        return { ok: false, kind: 'deferred', message: error.launch.reason }
      }
      return {
        ok: false,
        kind: error instanceof OrcadHostUnsupportedError ? 'unsupported-wsl1' : 'failed',
        message: errorMessage(error)
      }
    }
    try {
      addWslHostEnvironment(userDataPath, {
        id: environmentId,
        name: wslHostEnvironmentLabel(distro.name),
        pairingCode: connection.pairingOffer,
        record: {
          kind: 'wsl',
          distro: distro.name,
          distroId: distro.id,
          localPort: connection.localPort,
          remotePort: connection.remotePort
        }
      })
    } catch (error) {
      await this.wsl.disconnect(distro.name).catch(() => {})
      await this.wsl.releaseHolder(distro.name).catch(() => {})
      return { ok: false, kind: 'failed', message: errorMessage(error) }
    }
    const record = this.recordForEnvironment(environmentId)
    if (record) {
      this.setStatus(record, { state: 'ready', census: null })
    }
    this.deps.ready(environmentId)
    return { ok: true, environmentId }
  }

  private setStatus(record: WslHostDeploymentRecord, status: WslOrcadConnectionStatus): void {
    const next: WslHostStatus = {
      environmentId: record.environmentId,
      distro: record.distro,
      state: status.state,
      detail:
        status.state === 'failed'
          ? status.reason
          : status.state === 'unverifiable'
            ? status.reason
            : null
    }
    this.statuses.set(record.environmentId, next)
    this.deps.publish(next)
  }

  private records(): WslHostDeploymentRecord[] {
    try {
      return readWslHostDeployments(this.deps.userDataPath()).deployments
    } catch (error) {
      console.warn('[wsl-hosts] Could not read WSL host records:', error)
      return []
    }
  }

  private recordForDistro(distro: string): WslHostDeploymentRecord | null {
    return this.records().find((record) => sameWslDistro(record.distro, distro)) ?? null
  }

  private recordForEnvironment(environmentId: string): WslHostDeploymentRecord | null {
    return this.records().find((record) => record.environmentId === environmentId) ?? null
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
