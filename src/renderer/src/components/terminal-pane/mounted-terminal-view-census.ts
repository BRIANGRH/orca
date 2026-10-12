export type MountedTerminalViewSource = {
  getRetainedBytes(): number
  /** Null for a visible or portaled view; read live state instead of parking candidates. */
  getHiddenState(): { restorable: boolean } | null
}

const mountedViewsByTabId = new Map<string, MountedTerminalViewSource>()

export function registerMountedTerminalTabView(
  tabId: string,
  source: MountedTerminalViewSource
): () => void {
  mountedViewsByTabId.set(tabId, source)
  return () => {
    if (mountedViewsByTabId.get(tabId) === source) {
      mountedViewsByTabId.delete(tabId)
    }
  }
}

/** Null when parked, not yet created, or unavailable for measurement. */
export function readMountedTerminalTabViewBytes(tabId: string): number | null {
  const source = mountedViewsByTabId.get(tabId)
  if (!source) {
    return null
  }
  try {
    return source.getRetainedBytes()
  } catch {
    return null
  }
}

export function collectMountedHiddenTerminalViewCounts(
  overBudgetByOwner: Iterable<ReadonlySet<string>>
): Record<string, number> {
  const overBudget = new Set<string>()
  for (const tabIds of overBudgetByOwner) {
    for (const tabId of tabIds) {
      overBudget.add(tabId)
    }
  }
  let keptViews = 0
  let keptBytes = 0
  let overBudgetViews = 0
  let unrestorableViews = 0
  let unrestorableBytes = 0
  for (const [tabId, source] of mountedViewsByTabId) {
    try {
      const hidden = source.getHiddenState()
      if (!hidden) {
        continue
      }
      const measuredBytes = readMountedTerminalTabViewBytes(tabId) ?? 0
      const bytes = Number.isFinite(measuredBytes) ? measuredBytes : 0
      if (!hidden.restorable) {
        unrestorableViews += 1
        unrestorableBytes += bytes
      } else if (overBudget.has(tabId)) {
        overBudgetViews += 1
      } else {
        keptViews += 1
        keptBytes += bytes
      }
    } catch {
      // Diagnostics cannot disrupt another mounted view or the memory sampler.
    }
  }
  return {
    keptViews,
    keptKB: Math.round(keptBytes / 1024),
    overBudgetViews,
    unrestorableViews,
    unrestorableKB: Math.round(unrestorableBytes / 1024)
  }
}

export function resetMountedTerminalViewsForTest(): void {
  mountedViewsByTabId.clear()
}
