/** The production WSL side of `WslHostService`: one holder, connection manager and supervisor. */
import { execCommand } from '../ssh/ssh-relay-exec-command'
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
import { createWslOrcadLivenessSupervisor } from './wsl-orcad-liveness-wiring'
import type { WslOrcadLivenessSupervisor } from './wsl-orcad-liveness-supervisor'

function transportFor(distro: string) {
  return createWslOrcadHostTransport({
    target: { kind: 'wsl', id: defaultWslOrcadEnvironmentId(distro), distro, label: distro }
  })
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
    stopServer: async (distro, pid) => {
      if (!(await isWslDistroRunning(distro))) {
        return
      }
      await execCommand(transportFor(distro), `kill ${Math.trunc(pid)} 2>/dev/null || true`)
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
