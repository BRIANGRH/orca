import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { WslHostStatus } from '../../../../shared/wsl-host-types'

/** Each WSL host's connection status as main's liveness owner publishes it, by environment id. */
export type WslHostsSlice = {
  wslHostStatuses: Readonly<Record<string, WslHostStatus>>
  applyWslHostStatus: (status: WslHostStatus) => void
}

export const createWslHostsSlice: StateCreator<AppState, [], [], WslHostsSlice> = (set) => ({
  wslHostStatuses: {},
  applyWslHostStatus: (status) =>
    set((state) => {
      const current = state.wslHostStatuses[status.environmentId]
      if (
        current &&
        current.state === status.state &&
        current.detail === status.detail &&
        current.distro === status.distro
      ) {
        return state
      }
      return { wslHostStatuses: { ...state.wslHostStatuses, [status.environmentId]: status } }
    })
})
