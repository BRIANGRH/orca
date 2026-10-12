/** The production WSL side of `WslHostService`: one holder, connection manager and supervisor. */
import { createWslDistroHolder } from './wsl-distro-holder'
import { listWslHostDistros } from './wsl-host-distro-list'
import type { WslHostConnector } from './wsl-host-service'
import { readWslDistroOrcadPublicKey } from './wsl-host-ssh-orcad-conflict'
import {
  WslOrcadConnectionManager,
  type WslOrcadConnectionDependencies
} from './wsl-orcad-connection'
import { defaultWslOrcadEnvironmentId } from './wsl-orcad-deploy'
import { createWslOrcadHostTransport } from './wsl-orcad-host-transport'
import { createWslOrcadLivenessSupervisor } from './wsl-orcad-liveness-wiring'
import type { WslOrcadLivenessSupervisor } from './wsl-orcad-liveness-supervisor'

export function createWslHostConnector(options: {
  userDataPath: string
  onChange: NonNullable<WslOrcadConnectionDependencies['onChange']>
  hasUserVisibleWork: (distro: string) => boolean
}): WslHostConnector {
  // Assigned below; a holder exit cannot arrive before the first ensure.
  let supervisor: WslOrcadLivenessSupervisor | null = null
  const holder = createWslDistroHolder({
    userDataPath: options.userDataPath,
    onHolderExit: (distro, exit) => supervisor?.noteHolderExit(distro, exit)
  })
  const manager = new WslOrcadConnectionManager({ holder, onChange: options.onChange })
  const liveness = createWslOrcadLivenessSupervisor({
    manager,
    holder,
    hasUserVisibleWork: options.hasUserVisibleWork
  })
  supervisor = liveness
  return {
    listDistros: () => listWslHostDistros(),
    readOrcadPublicKey: (distro) =>
      readWslDistroOrcadPublicKey(
        createWslOrcadHostTransport({
          target: { kind: 'wsl', id: defaultWslOrcadEnvironmentId(distro), distro, label: distro }
        })
      ),
    connect: (distro) => liveness.connect(distro),
    get: (distro) => manager.get(distro),
    disconnect: (distro) => liveness.stop(distro),
    releaseHolder: async (distro) => {
      await holder.release(distro)
    },
    adoptHolders: async () => {
      await holder.adoptHolders()
    },
    dispose: () => liveness.dispose()
  }
}
