/** WSL distros as hosts; desktop-only and Windows-only (or the e2e fake), else undefined. */
import { ipcRenderer } from 'electron'
import {
  WSL_HOST_STATUS_CHANNEL,
  type WslHostAddResult,
  type WslHostCapability,
  type WslHostDistro,
  type WslHostStatus
} from '../../shared/wsl-host-types'

export type WslHostsPreloadApi = {
  getCapability: () => Promise<WslHostCapability>
  listDistros: () => Promise<WslHostDistro[]>
  add: (args: { distro: string; startIfStopped?: boolean }) => Promise<WslHostAddResult>
  remove: (args: { environmentId: string }) => Promise<void>
  connect: (args: { environmentId: string }) => Promise<void>
  getStatuses: () => Promise<WslHostStatus[]>
  onStatusChanged: (callback: (status: WslHostStatus) => void) => () => void
  /** The WSL hosts an open project or terminal needs; only these may boot a stopped distro. */
  setVisibleWork: (args: { environmentIds: string[] }) => Promise<void>
}

const wslHostsApi: WslHostsPreloadApi = {
  getCapability: () => ipcRenderer.invoke('wslHosts:getCapability'),
  listDistros: () => ipcRenderer.invoke('wslHosts:listDistros'),
  add: (args) => ipcRenderer.invoke('wslHosts:add', args),
  remove: (args) => ipcRenderer.invoke('wslHosts:remove', args),
  connect: (args) => ipcRenderer.invoke('wslHosts:connect', args),
  getStatuses: () => ipcRenderer.invoke('wslHosts:getStatuses'),
  onStatusChanged: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, status: WslHostStatus): void =>
      callback(status)
    ipcRenderer.on(WSL_HOST_STATUS_CHANNEL, listener)
    return () => ipcRenderer.removeListener(WSL_HOST_STATUS_CHANNEL, listener)
  },
  setVisibleWork: (args) => ipcRenderer.invoke('wslHosts:setVisibleWork', args)
}

export function getWslHostsApi(): WslHostsPreloadApi | undefined {
  return process.platform === 'win32' || process.env.ORCA_E2E_FAKE_WSL_HOSTS
    ? wslHostsApi
    : undefined
}
