import { useAppStore } from '@/store'

/** Releases the distro's holder, drops the host's records, then refreshes the host list. */
export async function removeWslHost(environmentId: string): Promise<void> {
  const api = window.api.runtimeEnvironments?.wslHosts
  if (!api) {
    throw new Error('WSL hosts are not available on this computer.')
  }
  await api.remove({ environmentId })
  useAppStore.getState().setRuntimeEnvironments(await window.api.runtimeEnvironments.list())
}
