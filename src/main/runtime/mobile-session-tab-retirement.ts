import type {
  RuntimeMobileSessionSnapshotTab,
  RuntimeMobileSessionTabsSnapshot
} from '../../shared/runtime-types'
import {
  chooseActiveSurface,
  pruneTabGroupLayoutAfterRetirement,
  repairMobileSessionTabGroupsAfterRetirement
} from './mobile-session-terminal-retirement'

/** The host's own writer and emitter for a stored snapshot. */
export type MobileSessionSnapshotPublisher = {
  mobileSessionTabsByWorktree: ReadonlyMap<string, RuntimeMobileSessionTabsSnapshot>
  storeMobileSessionSnapshot(
    worktreeId: string,
    snapshot: RuntimeMobileSessionTabsSnapshot
  ): RuntimeMobileSessionTabsSnapshot
  emitMobileSessionTabsSnapshot(snapshot: RuntimeMobileSessionTabsSnapshot): void
}

/** Stores a retirement as a new version and emits it; nothing when there was nothing to retire. */
export function publishMobileSessionRetirement(
  host: MobileSessionSnapshotPublisher,
  worktreeId: string,
  next: RuntimeMobileSessionTabsSnapshot | null
): void {
  if (next) {
    host.emitMobileSessionTabsSnapshot(host.storeMobileSessionSnapshot(worktreeId, next))
  }
}

/** The ids a group order may name this tab by, as the host's projection reads them. */
function groupOrderIds(tab: RuntimeMobileSessionSnapshotTab): string[] {
  if (tab.type === 'terminal') {
    return [tab.id, tab.parentTabId]
  }
  return tab.type === 'browser' ? [tab.id, tab.browserWorkspaceId] : [tab.id]
}

/**
 * The snapshot with one listed tab removed, or null when it does not list that id. For a whole
 * tab only: a terminal pane id would drop the pane's whole split from the group order.
 *
 * Pure: the caller stores and emits. How a closed chat, browser or editor tab leaves the host's
 * list. Groups are repaired as a terminal retirement repairs them: a group the tab leaves empty is
 * dropped with its layout leaf, and the active tab and group move to ones that still exist.
 */
export function retireMobileSessionTabFrom(
  snapshot: RuntimeMobileSessionTabsSnapshot,
  tabId: string
): RuntimeMobileSessionTabsSnapshot | null {
  const retired = snapshot.tabs.find((candidate) => candidate.id === tabId)
  if (!retired) {
    return null
  }
  const retiredIds = new Set(groupOrderIds(retired))
  const tabs = snapshot.tabs.filter((candidate) => candidate.id !== tabId)
  // Why every other id: group orders also carry ids no listed tab answers to, which a projection drops.
  const retainedGroupTabIds = new Set(
    (snapshot.tabGroups ?? [])
      .flatMap((group) => group.tabOrder)
      .filter((id) => !retiredIds.has(id))
  )
  const tabGroups = repairMobileSessionTabGroupsAfterRetirement(
    snapshot.tabGroups,
    retainedGroupTabIds
  )
  const active = chooseActiveSurface(tabs, snapshot.activeTabId, tabGroups, snapshot.activeGroupId)
  const activeOrderIds = active ? groupOrderIds(active) : []
  const retainedGroupIds = new Set(tabGroups?.map((group) => group.id) ?? [])
  const activeGroupId =
    tabGroups?.find((group) => group.tabOrder.some((id) => activeOrderIds.includes(id)))?.id ??
    (snapshot.activeGroupId && retainedGroupIds.has(snapshot.activeGroupId)
      ? snapshot.activeGroupId
      : null) ??
    tabGroups?.[0]?.id ??
    null
  return {
    ...snapshot,
    snapshotVersion: snapshot.snapshotVersion + 1,
    activeGroupId,
    activeTabId: active?.id ?? null,
    activeTabType: active?.type ?? null,
    tabGroups,
    ...(snapshot.tabGroupLayout
      ? {
          tabGroupLayout: pruneTabGroupLayoutAfterRetirement(
            snapshot.tabGroupLayout,
            retainedGroupIds
          )
        }
      : {}),
    tabs: tabs.map((tab) => ({ ...tab, isActive: tab.id === active?.id }))
  }
}
