import type {
  RuntimeMobileSessionRetiredTerminalSurface,
  RuntimeMobileSessionTabsSnapshot,
  RuntimeMobileSessionTerminalTab
} from '../../shared/runtime-types'
import { retireTerminalSurfacesFromSnapshot } from './mobile-session-terminal-retirement'
import { attachRetirementProofsToSnapshot } from './mobile-session-terminal-retirement-proof'
import {
  publishMobileSessionRetirement,
  type MobileSessionSnapshotPublisher
} from './mobile-session-tab-retirement'
import type { RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'

/**
 * The snapshot without a closed terminal tab, or null unless every surface it lists for that tab
 * carries its own retirement proof.
 *
 * Why all-or-nothing: a paired client treats a terminal that vanishes without a proof as an orphan
 * to recover, so a surface with no proof stays listed until the window's own republish drops it.
 */
export function retireProvenTerminalTabFrom(
  snapshot: RuntimeMobileSessionTabsSnapshot,
  parentTabId: string,
  proofs: readonly RuntimeMobileSessionRetiredTerminalSurface[]
): RuntimeMobileSessionTabsSnapshot | null {
  const surfaces = snapshot.tabs.filter(
    (tab): tab is RuntimeMobileSessionTerminalTab =>
      tab.type === 'terminal' && tab.parentTabId === parentTabId
  )
  let next: RuntimeMobileSessionTabsSnapshot | null = null
  for (const surface of surfaces) {
    const proof = proofs.find(
      (candidate) => candidate.parentTabId === parentTabId && candidate.leafId === surface.leafId
    )
    const retired = proof
      ? retireTerminalSurfacesFromSnapshot({
          snapshot: next ?? snapshot,
          ptyId: proof.ptyId,
          exactSurfaces: [surface],
          exactOnly: true,
          retirementProofs: [proof]
        })
      : null
    if (!retired) {
      return null
    }
    next = retired.snapshot
  }
  return next
}

/**
 * After the window acknowledged closing a terminal tab: drops it with its proofs, or, when the
 * window's own frame already dropped it, still ships the proofs so paired clients can retire it.
 */
export function retireAcknowledgedTerminalTabFrom(
  snapshot: RuntimeMobileSessionTabsSnapshot,
  parentTabId: string,
  proofs: readonly RuntimeMobileSessionRetiredTerminalSurface[]
): RuntimeMobileSessionTabsSnapshot | null {
  const listed = snapshot.tabs.some(
    (tab) => tab.type === 'terminal' && tab.parentTabId === parentTabId
  )
  return listed
    ? retireProvenTerminalTabFrom(snapshot, parentTabId, proofs)
    : attachRetirementProofsToSnapshot(snapshot, proofs)
}

export type TerminalTabListRetirementHost = MobileSessionSnapshotPublisher & {
  captureMobileSessionTerminalTabRetirementProofs(
    worktreeId: string,
    snapshot: RuntimeMobileSessionTabsSnapshot,
    parentTabId: string,
    authorizedPty?: RuntimePtyWorktreeRecord
  ): RuntimeMobileSessionRetiredTerminalSurface[]
}

/**
 * Captures a terminal tab's proofs now, before the window's close kills its PTYs; the returned
 * call retires the tab from the host list with them once the window has acknowledged the close.
 * Returns whether the host list now omits the parent.
 */
export function captureTerminalTabListRetirement(
  host: TerminalTabListRetirementHost,
  snapshot: RuntimeMobileSessionTabsSnapshot,
  tab: RuntimeMobileSessionTerminalTab,
  ptyCloseAuthority?: { pty: RuntimePtyWorktreeRecord } | null
): () => boolean {
  const worktreeId = snapshot.worktree
  const proofs = host.captureMobileSessionTerminalTabRetirementProofs(
    worktreeId,
    snapshot,
    tab.parentTabId,
    ptyCloseAuthority?.pty
  )
  return () => {
    const current = host.mobileSessionTabsByWorktree.get(worktreeId)
    publishMobileSessionRetirement(
      host,
      worktreeId,
      current ? retireAcknowledgedTerminalTabFrom(current, tab.parentTabId, proofs) : null
    )
    return !host.mobileSessionTabsByWorktree
      .get(worktreeId)
      ?.tabs.some(
        (candidate) => candidate.type === 'terminal' && candidate.parentTabId === tab.parentTabId
      )
  }
}
