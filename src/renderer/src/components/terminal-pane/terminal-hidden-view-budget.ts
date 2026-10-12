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
  /** Tabs the pass keeps mounted even when parked (sleeping-session owner, split lease). */
  isHeldMounted?: (tab: TerminalTabColdParkCandidate) => boolean
}

export type HiddenTerminalView = {
  tabId: string
  hiddenSinceMs: number
  activationSeq?: number
  /** Estimated retained bytes; Infinity when never measured (never kept on a guess). */
  bytes: number
  /** Past the cold-park delay and otherwise park-eligible right now. */
  parkable: boolean
  /** Kept mounted for another reason even if parked, so it always holds its memory. */
  held?: boolean
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

/** A view's size for its current hidden episode. */
export type HiddenViewSize = { hiddenSinceMs: number; bytes: number }

/**
 * One worktree's hidden views that parking could release. Unrestorable views
 * stay out (no budget can release them), as do clock-parked views unless another
 * owner keeps them mounted. Size is the largest measured in the current hidden
 * episode and is remembered after the view parks, so neither parking nor a remount
 * mid-restore makes a view look small and flip it back in.
 */
export function buildHiddenTerminalViews(
  input: HiddenViewBudgetInput,
  sizeByTabId: Map<string, HiddenViewSize>
): HiddenTerminalView[] {
  const liveTabIds = new Set(input.terminalTabs.map((tab) => tab.id))
  for (const tabId of Array.from(sizeByTabId.keys())) {
    if (!liveTabIds.has(tabId)) {
      sizeByTabId.delete(tabId)
    }
  }
  const views: HiddenTerminalView[] = []
  for (const tab of input.terminalTabs) {
    if (
      tab.isVisible ||
      tab.hasActivityTerminalPortal ||
      tab.hiddenSinceMs === null ||
      !isParkRestorableTerminalPty(tab.ptyId, input.worktreeId, input.restorePolicy)
    ) {
      continue
    }
    // A sleeping record or split lease alone does not prove a view is allocated.
    const held = input.isHeldMounted?.(tab) === true && mountedViewsByTabId.has(tab.id)
    if (input.clockParkedTabIds.has(tab.id) && !held) {
      continue
    }
    const known = sizeByTabId.get(tab.id)
    const sameEpisode = known?.hiddenSinceMs === tab.hiddenSinceMs
    const mountedBytes = readMountedTerminalTabViewBytes(tab.id)
    if (mountedBytes !== null) {
      sizeByTabId.set(tab.id, {
        hiddenSinceMs: tab.hiddenSinceMs,
        bytes: sameEpisode ? Math.max(known.bytes, mountedBytes) : mountedBytes
      })
    }
    views.push({
      tabId: tab.id,
      hiddenSinceMs: tab.hiddenSinceMs,
      ...(tab.lastActivatedSeq !== undefined ? { activationSeq: tab.lastActivatedSeq } : {}),
      bytes: sizeByTabId.get(tab.id)?.bytes ?? Number.POSITIVE_INFINITY,
      parkable: input.parkableTabIds.has(tab.id),
      held
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
 * Most recently hidden first, each view stays loaded while it still fits; the
 * last-hidden view is spared only while it fits on its own. A held view always
 * reserves budget before ordinary admission. A view that does not fit but cannot
 * park yet (cold-park delay) uses none: it parks once it can, so older views stay put meanwhile.
 */
export function selectHiddenTerminalViewsOverBudget(
  views: readonly HiddenTerminalView[],
  budgetBytes: number
): Set<string> {
  const overBudget = new Set<string>()
  let retainedBytes = views.reduce((bytes, view) => bytes + (view.held ? view.bytes : 0), 0)
  for (const view of [...views].sort(compareHiddenViewRecencyDesc)) {
    if (view.held) {
      continue
    }
    if (retainedBytes + view.bytes <= budgetBytes) {
      retainedBytes += view.bytes
    } else if (view.parkable) {
      overBudget.add(view.tabId)
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
