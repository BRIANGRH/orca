import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'

/**
 * Ends the host's terminals and Orca's server in its distro, drops the host's records, then
 * refreshes the host list. Anything main could not end is reported, since it keeps the distro up.
 */
export async function removeWslHost(environmentId: string): Promise<void> {
  const api = window.api.runtimeEnvironments?.wslHosts
  if (!api) {
    throw new Error('WSL hosts are not available on this computer.')
  }
  const serverStop = await api.remove({ environmentId })
  useAppStore.getState().setRuntimeEnvironments(await window.api.runtimeEnvironments.list())
  // Why `=== false`: an older main answered nothing here.
  if (serverStop?.stopped === false) {
    toast.warning(
      translate(
        'auto.components.sidebar.wslHostRemoval.partial',
        'The host was removed, but something in the distro is still running: {{value0}}',
        { value0: serverStop.reason }
      )
    )
  }
}
