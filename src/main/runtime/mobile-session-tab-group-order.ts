import type { RuntimeMobileSessionSnapshotTab } from '../../shared/runtime-types'

/** The ids a group order may name this tab by, as the host's projection reads them. */
export function mobileSessionTabGroupOrderIds(tab: RuntimeMobileSessionSnapshotTab): string[] {
  if (tab.type === 'terminal') {
    return [tab.id, tab.parentTabId]
  }
  return tab.type === 'browser' ? [tab.id, tab.browserWorkspaceId] : [tab.id]
}
