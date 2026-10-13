/** IPC for WSL hosts (WSL-via-orcad C7); Windows only, or an e2e fake on any OS. */
import { BrowserWindow, ipcMain } from 'electron'
import {
  WSL_HOST_STATUS_CHANNEL,
  type WslHostCapability,
  type WslHostStatus
} from '../../shared/wsl-host-types'
import type { Store } from '../persistence'
import { createWslHostConnector } from '../wsl/wsl-host-connector'
import {
  createFakeWslHostConnector,
  readFakeWslHostsConfig
} from '../wsl/wsl-host-e2e-fake-connector'
import { hasOrcadTemplate } from '../orcad/orcad-artifact-materializer'
import { WslHostService } from '../wsl/wsl-host-service'
import { getWslHostService, setWslHostService } from '../wsl/wsl-host-service-instance'
import { retireRemovedRuntimeEnvironment } from './runtime-environment-removal-cleanup'
import { getRuntimeEnvironmentStatus } from './runtime-environment-status-probe'
import { callRuntimeEnvironment } from './runtime-environment-transport-routing'
import { resolveEnvironment } from '../../shared/runtime-environment-store'
import { getPreferredPairedRuntimeConnection } from '../../shared/runtime-environments'
import { requestOrcadTerminalCensus } from '../ssh/orcad-terminal-census-client'
import type { WslHostRuntimeAccess } from '../wsl/wsl-host-server-stop'

export const WSL_HOST_HANDLER_CHANNELS = [
  'wslHosts:listDistros',
  'wslHosts:add',
  'wslHosts:remove',
  'wslHosts:connect',
  'wslHosts:getStatuses',
  'wslHosts:setVisibleWork',
  'wslHosts:getCapability'
] as const

function publish(status: WslHostStatus): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      try {
        window.webContents.send(WSL_HOST_STATUS_CHANNEL, status)
      } catch {
        /* A renderer can close during publication. */
      }
    }
  }
}

/** Removal reaches orcad the way every other call to the host does: by environment id. */
function wslHostRuntimeAccess(getUserDataPath: () => string): WslHostRuntimeAccess {
  return {
    call: async (environmentId, method, params) => {
      const response = await callRuntimeEnvironment(
        getUserDataPath(),
        environmentId,
        method,
        params
      )
      if (!response.ok) {
        throw new Error(response.error.message)
      }
      return response.result
    },
    census: (environmentId) =>
      requestOrcadTerminalCensus(
        getPreferredPairedRuntimeConnection(resolveEnvironment(getUserDataPath(), environmentId)),
        0
      )
  }
}

function createService(args: {
  store: Store
  getUserDataPath: () => string
  invalidateTransport: (environmentId: string) => Promise<void> | void
}): WslHostService | null {
  const fake = readFakeWslHostsConfig()
  if (process.platform !== 'win32' && !fake) {
    return null
  }
  const created = new WslHostService({
    userDataPath: args.getUserDataPath,
    isEnabled: () => args.store.getSettings().experimentalWslHosts === true,
    hasServerFiles: fake ? () => fake.serverFiles !== 'missing' : hasOrcadTemplate,
    publish,
    pairingChanged: (environmentId) => void args.invalidateTransport(environmentId),
    ready: (environmentId) => {
      void getRuntimeEnvironmentStatus(args.getUserDataPath(), environmentId, undefined, {
        reconnect: true
      }).catch(() => {})
    },
    removed: (environmentId) =>
      retireRemovedRuntimeEnvironment(environmentId, args.invalidateTransport, args.store)
  })
  const onChange = created.handleConnectionChange.bind(created)
  const isKnownDistro = (distro: string): boolean => created.isKnownDistro(distro)
  const runtime = wslHostRuntimeAccess(args.getUserDataPath)
  created.attach(
    fake
      ? createFakeWslHostConnector(fake, onChange, { isKnownDistro, runtime })
      : createWslHostConnector({
          userDataPath: args.getUserDataPath(),
          onChange,
          hasUserVisibleWork: (distro) => created.hasUserVisibleWork(distro),
          isKnownDistro,
          runtime
        })
  )
  return created
}

export function registerWslHostHandlers(args: {
  store: Store
  getUserDataPath: () => string
  invalidateTransport: (environmentId: string) => Promise<void> | void
}): void {
  for (const channel of WSL_HOST_HANDLER_CHANNELS) {
    ipcMain.removeHandler(channel)
  }
  if (!getWslHostService()) {
    const created = createService(args)
    setWslHostService(created)
    args.store.onSettingsChanged((updates, settings) => {
      if ('experimentalWslHosts' in updates) {
        void created?.enabledChanged(settings.experimentalWslHosts === true).catch((error) => {
          console.warn('[wsl-hosts] Could not apply the WSL hosts setting:', error)
        })
      }
    })
    void created?.start().catch((error: unknown) => {
      console.warn('[wsl-hosts] Could not adopt WSL distro holders:', error)
    })
  }
  const wsl = getWslHostService()
  ipcMain.handle('wslHosts:listDistros', () => wsl?.listDistros() ?? [])
  ipcMain.handle('wslHosts:add', (_event, request: { distro: string; startIfStopped?: boolean }) =>
    wsl
      ? wsl.add(request)
      : { ok: false, kind: 'failed', message: 'WSL hosts are not available on this computer.' }
  )
  ipcMain.handle('wslHosts:remove', async (_event, request: { environmentId: string }) => {
    if (args.store.getSettings().activeRuntimeEnvironmentId === request.environmentId) {
      throw new Error(
        'This server is the default host for new projects. Choose another one in Advanced before removing it.'
      )
    }
    return wsl ? wsl.remove(request.environmentId) : { stopped: true }
  })
  ipcMain.handle('wslHosts:connect', async (_event, request: { environmentId: string }) => {
    await wsl?.connect(request.environmentId)
  })
  ipcMain.handle('wslHosts:getCapability', (): WslHostCapability => ({
    serverFiles: wsl?.hasServerFiles() ?? false
  }))
  ipcMain.handle('wslHosts:getStatuses', () => wsl?.getStatuses() ?? [])
  ipcMain.handle('wslHosts:setVisibleWork', (_event, request: { environmentIds: string[] }) => {
    wsl?.setVisibleWork(Array.isArray(request.environmentIds) ? request.environmentIds : [])
  })
}
