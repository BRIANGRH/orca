import { useAppStore } from '@/store'

/** True where WSL distros can be hosts (a Windows desktop) and the Experimental toggle is on. */
export function wslHostsAvailable(): boolean {
  return typeof window !== 'undefined' && window.api?.runtimeEnvironments?.wslHosts !== undefined
}

export function useWslHostsEnabled(): boolean {
  const enabled = useAppStore((s) => s.settings?.experimentalWslHosts === true)
  return enabled && wslHostsAvailable()
}

/** Settings → Experimental → WSL distros as hosts. */
export function openWslHostsExperimentalSetting(): void {
  const { openSettingsPage, openSettingsTarget } = useAppStore.getState()
  openSettingsPage()
  openSettingsTarget({ pane: 'experimental', repoId: null, sectionId: 'wsl-hosts' })
}
