/**
 * One renderer-wide memory budget for hidden terminal views that stay loaded.
 *
 * Why: hidden views keep a full live xterm (scrollback, parser, image caches)
 * whose size varies ~100x with columns and scrollback rows, so a count of
 * warm tabs or worktrees cannot bound memory. Every cold-park hook reports its
 * hidden restorable tabs here; the most recently hidden stay loaded while they
 * fit, the rest take the ordinary park path (watchers + snapshot restore).
 */

import {
  isParkRestorableTerminalPty,
  type TerminalParkRestorePolicy,
  type TerminalTabColdParkCandidate
} from './terminal-hidden-view-parking'

export const TERMINAL_HIDDEN_VIEW_BUDGET_BYTES = 384 * 1024 * 1024

/** What one worktree's tab pass hands the budget. */
export type HiddenViewBudgetInput = {
  worktreeId: string
  terminalTabs: readonly TerminalTabColdParkCandidate[]
  parkableTabIds: ReadonlySet<string>
  clockParkedTabIds: ReadonlySet<string>
  restorePolicy?: TerminalParkRestorePolicy
}

export type HiddenTerminalView = {
  tabId: string
  hiddenSinceMs: number
  activationSeq?: number
  /** Estimated retained bytes; Infinity when never measured (never kept on a guess). */
  bytes: number
  /** Past the cold-park delay and otherwise park-eligible right now. */
  parkable: boolean
}

type RetainedBytesSource = { getRetainedBytes(): number }

const mountedViewsByTabId = new Map<string, RetainedBytesSource>()

/** Called by the pane mount; the returned disposer runs on unmount. */
export function registerMountedTerminalTabView(
  tabId: string,
  source: RetainedBytesSource
): () => void {
  mountedViewsByTabId.set(tabId, source)
  return () => {
    if (mountedViewsByTabId.get(tabId) === source) {
      mountedViewsByTabId.delete(tabId)
    }
  }
}

/** Null when the tab has no mounted view (parked, or not yet created). */
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

/**
 * One worktree's hidden views that parking could release. Unrestorable views
 * stay out (no budget can release them), and so do views the hot-retain clock
 * already parks. Bytes are measured while the view is mounted and remembered
 * after it parks, so parking never makes a view look free and flip it back in.
 */
export function buildHiddenTerminalViews(
  input: HiddenViewBudgetInput,
  lastKnownBytesByTabId: Map<string, number>
): HiddenTerminalView[] {
  const liveTabIds = new Set(input.terminalTabs.map((tab) => tab.id))
  for (const tabId of Array.from(lastKnownBytesByTabId.keys())) {
    if (!liveTabIds.has(tabId)) {
      lastKnownBytesByTabId.delete(tabId)
    }
  }
  const views: HiddenTerminalView[] = []
  for (const tab of input.terminalTabs) {
    if (
      tab.isVisible ||
      tab.hasActivityTerminalPortal ||
      tab.hiddenSinceMs === null ||
      input.clockParkedTabIds.has(tab.id) ||
      !isParkRestorableTerminalPty(tab.ptyId, input.worktreeId, input.restorePolicy)
    ) {
      continue
    }
    const mountedBytes = readMountedTerminalTabViewBytes(tab.id)
    if (mountedBytes !== null) {
      lastKnownBytesByTabId.set(tab.id, mountedBytes)
    }
    views.push({
      tabId: tab.id,
      hiddenSinceMs: tab.hiddenSinceMs,
      ...(tab.lastActivatedSeq !== undefined ? { activationSeq: tab.lastActivatedSeq } : {}),
      bytes: lastKnownBytesByTabId.get(tab.id) ?? Number.POSITIVE_INFINITY,
      parkable: input.parkableTabIds.has(tab.id)
    })
  }
  return views
}

function compareHiddenViewRecencyDesc(a: HiddenTerminalView, b: HiddenTerminalView): number {
  if (a.hiddenSinceMs !== b.hiddenSinceMs) {
    return b.hiddenSinceMs - a.hiddenSinceMs
  }
  const activationDelta = (b.activationSeq ?? -1) - (a.activationSeq ?? -1)
  return activationDelta === 0 ? a.tabId.localeCompare(b.tabId) : activationDelta
}

/**
 * Most recently hidden first, each view stays loaded while it still fits. A
 * view inside the cold-park delay cannot park yet but still holds its memory,
 * so it uses budget ahead of older views. The last-hidden view is spared only
 * while it fits on its own.
 */
export function selectHiddenTerminalViewsOverBudget(
  views: readonly HiddenTerminalView[],
  budgetBytes: number
): Set<string> {
  const overBudget = new Set<string>()
  let retainedBytes = 0
  for (const view of [...views].sort(compareHiddenViewRecencyDesc)) {
    if (retainedBytes + view.bytes <= budgetBytes) {
      retainedBytes += view.bytes
    } else if (view.parkable) {
      overBudget.add(view.tabId)
    } else if (Number.isFinite(view.bytes)) {
      retainedBytes += view.bytes
    }
  }
  return overBudget
}

const EMPTY_TAB_IDS: ReadonlySet<string> = new Set()
const viewsByOwner = new Map<string, readonly HiddenTerminalView[]>()
const overBudgetByOwner = new Map<string, ReadonlySet<string>>()
const listenersByOwner = new Map<string, Set<() => void>>()
const ownersToNotify = new Set<string>()
let notifyTimer: ReturnType<typeof setTimeout> | null = null

function haveSameIds(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) {
    return false
  }
  for (const id of a) {
    if (!b.has(id)) {
      return false
    }
  }
  return true
}

// Why a macrotask: reports run inside cold-park effects; waking other hooks
// synchronously there would stack renders inside the same commit.
function scheduleNotify(ownerId: string): void {
  ownersToNotify.add(ownerId)
  notifyTimer ??= setTimeout(() => {
    notifyTimer = null
    const owners = Array.from(ownersToNotify)
    ownersToNotify.clear()
    for (const owner of owners) {
      for (const listener of listenersByOwner.get(owner) ?? []) {
        listener()
      }
    }
  }, 0)
}

/**
 * Replaces one cold-park hook's hidden views and returns which of them are
 * over the shared budget. Other hooks whose verdict changed are woken.
 */
export function reportHiddenTerminalViews(
  ownerId: string,
  views: readonly HiddenTerminalView[],
  budgetBytes: number = TERMINAL_HIDDEN_VIEW_BUDGET_BYTES
): ReadonlySet<string> {
  if (views.length === 0) {
    viewsByOwner.delete(ownerId)
  } else {
    viewsByOwner.set(ownerId, views)
  }
  const overBudget = selectHiddenTerminalViewsOverBudget(
    Array.from(viewsByOwner.values()).flat(),
    budgetBytes
  )
  for (const owner of new Set([...viewsByOwner.keys(), ...overBudgetByOwner.keys()])) {
    const next = new Set(
      (viewsByOwner.get(owner) ?? [])
        .filter((view) => overBudget.has(view.tabId))
        .map((view) => view.tabId)
    )
    const previous = overBudgetByOwner.get(owner) ?? EMPTY_TAB_IDS
    if (haveSameIds(previous, next)) {
      continue
    }
    if (next.size === 0) {
      overBudgetByOwner.delete(owner)
    } else {
      overBudgetByOwner.set(owner, next)
    }
    if (owner !== ownerId) {
      scheduleNotify(owner)
    }
  }
  return overBudgetByOwner.get(ownerId) ?? EMPTY_TAB_IDS
}

export function subscribeHiddenTerminalViewBudget(
  ownerId: string,
  listener: () => void
): () => void {
  let listeners = listenersByOwner.get(ownerId)
  if (!listeners) {
    listeners = new Set()
    listenersByOwner.set(ownerId, listeners)
  }
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      listenersByOwner.delete(ownerId)
    }
  }
}

export function resetHiddenTerminalViewBudgetForTest(): void {
  mountedViewsByTabId.clear()
  viewsByOwner.clear()
  overBudgetByOwner.clear()
  listenersByOwner.clear()
  ownersToNotify.clear()
  if (notifyTimer !== null) {
    clearTimeout(notifyTimer)
    notifyTimer = null
  }
}
