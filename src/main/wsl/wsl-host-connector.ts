/** The production WSL side of `WslHostService`: one holder, connection manager and supervisor. */
import { isWslDistroRunning } from '../wsl-background-distro-gate'
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
import type { WslOrcadHostTarget } from './wsl-orcad-host-target'
import { stopWslHostServer, wslHostServerStopSteps } from './wsl-host-server-stop'
import { createWslOrcadLivenessSupervisor } from './wsl-orcad-liveness-wiring'
import type { WslOrcadLivenessSupervisor } from './wsl-orcad-liveness-supervisor'

function targetFor(distro: string): WslOrcadHostTarget {
  return { kind: 'wsl', id: defaultWslOrcadEnvironmentId(distro), distro, label: distro }
}

function transportFor(distro: string) {
  return createWslOrcadHostTransport({ target: targetFor(distro) })
}

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
    readOrcadPublicKey: (distro) => readWslDistroOrcadPublicKey(transportFor(distro)),
    connect: (distro) => liveness.connect(distro),
    get: (distro) => manager.get(distro),
    disconnect: (distro) => liveness.stop(distro),
    stopServer: async (distro) => {
      let connection = manager.get(distro)
      if (!connection) {
        // A stopped distro runs nothing; a running one is reached without booting it.
        if (!(await isWslDistroRunning(distro))) {
          return { stopped: true }
        }
        connection = await liveness.connect(distro)
      }
      const target = targetFor(distro)
      return stopWslHostServer(
        wslHostServerStopSteps({
          connection,
          target,
          transport: createWslOrcadHostTransport({ target }),
          closeBridge: () => liveness.stop(distro)
        })
      )
    },
    releaseHolder: async (distro) => {
      await holder.release(distro)
    },
    adoptHolders: async () => {
      await holder.adoptHolders()
    },
    dispose: () => liveness.dispose()
  }
}
