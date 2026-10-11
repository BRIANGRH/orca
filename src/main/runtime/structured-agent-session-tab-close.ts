/**
 * A user's close of a chat tab on the host, by the tab id `session.tabs.close` carries.
 *
 * Every chat close ends in one host function, `closeStructuredAgentSessionOnHost`: hide in the
 * restore index, drop the tab from the host's list, stop the provider. A chat the host does not
 * list (its inventory is not restored yet, or it is still starting) is closed by session id.
 */

import type {
  RuntimeMobileSessionAgentTab,
  RuntimeMobileSessionTabsSnapshot,
  RuntimeSessionTabCloseReason
} from '../../shared/runtime-types'
import {
  AGENT_SESSION_WORKTREE_MISMATCH_CODE,
  SESSION_TAB_CLOSE_CANCELED_ERROR,
  SESSION_TAB_NOT_FOUND_ERROR
} from '../../shared/session-tab-close'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import type { StructuredAgentSessionCloseCause } from '../native-chat/agent-session-wire/structured-agent-session-host-lifetime'
import type { RuntimeNotifier } from './runtime-notifier-contract'
import {
  getStructuredAgentSessionClosesInFlight,
  type StructuredAgentSessionCloseRequest
} from './structured-agent-session-closes-in-flight'
import { findStructuredAgentSessionTab } from './structured-agent-session-tab-retirement'
import { structuredAgentSessionTabCloseCause } from './structured-agent-session-tab-close-cause'

const HOST_CHAT_TAB_ID_PREFIX = 'agent-session:'

/** The session a host chat tab id names, or null for every other tab id. */
export function structuredAgentSessionIdFromHostTabId(tabId: string): string | null {
  return tabId.startsWith(HOST_CHAT_TAB_ID_PREFIX) && tabId.length > HOST_CHAT_TAB_ID_PREFIX.length
    ? tabId.slice(HOST_CHAT_TAB_ID_PREFIX.length)
    : null
}

/** A user's close of a chat tab, which takes the chat path rather than the terminal-aware one. */
export function isUserStructuredAgentSessionTabClose(
  tabId: string,
  options: {
    reason?: RuntimeSessionTabCloseReason
    expectedPublicationEpoch?: string
    expectedTerminalHandle?: string
    expectedPtyCloseAuthority?: unknown
  }
): boolean {
  return (
    structuredAgentSessionIdFromHostTabId(tabId) !== null &&
    (options.reason === undefined || options.reason === 'user') &&
    options.expectedPublicationEpoch === undefined &&
    options.expectedTerminalHandle === undefined &&
    options.expectedPtyCloseAuthority === undefined
  )
}

/** The runtime the host close drops a chat's tab from. */
export type StructuredAgentSessionCloseRuntime = WeakKey & {
  retireStructuredAgentSessionTabFromSnapshot(sessionId: string): boolean
  ensureStructuredAgentSessionHostForClose(): Promise<void>
}

export type StructuredAgentSessionTabCloseHost = StructuredAgentSessionCloseRuntime & {
  mobileSessionTabsByWorktree: ReadonlyMap<string, RuntimeMobileSessionTabsSnapshot>
  notifier: Pick<RuntimeNotifier, 'closeSessionTab'> | null
}

export type StructuredAgentSessionTabCloseOptions = {
  reason?: RuntimeSessionTabCloseReason
  structuredCloseRequest?: StructuredAgentSessionCloseRequest
  originatingWindowId?: number
}

/** Owned aliases take precedence over the spelling of an unlisted canonical id. */
export function structuredAgentSessionIdForTabClose(
  host: Pick<StructuredAgentSessionTabCloseHost, 'mobileSessionTabsByWorktree'>,
  tabId: string
): string | null {
  return (
    ownedStructuredAgentSessionIdForTab(host, tabId) ?? structuredAgentSessionIdFromHostTabId(tabId)
  )
}

function ownedStructuredAgentSessionIdForTab(
  host: Pick<StructuredAgentSessionTabCloseHost, 'mobileSessionTabsByWorktree'>,
  tabId: string
): string | null {
  const store = getStructuredAgentSessionHost()?.deps.store
  const owned = store?.getSessionIdForTab?.(tabId)
  if (owned) {
    return owned
  }
  for (const snapshot of host.mobileSessionTabsByWorktree.values()) {
    const tab = snapshot.tabs.find((candidate) => candidate.id === tabId)
    if (tab?.type === 'agent-session') {
      return tab.sessionId
    }
  }
  return null
}

function assertOriginalCloseTarget(
  host: StructuredAgentSessionTabCloseHost,
  tabId: string,
  request?: StructuredAgentSessionCloseRequest,
  listedSessionId?: string
): void {
  if (!request) {
    return
  }
  const current = ownedStructuredAgentSessionIdForTab(host, tabId)
  const retargeted = [...host.mobileSessionTabsByWorktree.values()].some((snapshot) =>
    snapshot.tabs.some(
      (tab) =>
        tab.id === tabId && tab.type === 'agent-session' && tab.sessionId !== request.sessionId
    )
  )
  if (
    retargeted ||
    (listedSessionId !== undefined && listedSessionId !== request.sessionId) ||
    (current !== null && current !== request.sessionId)
  ) {
    throw new Error(SESSION_TAB_CLOSE_CANCELED_ERROR)
  }
}

/**
 * The host's one close of a chat, by session id, whether or not its tab is listed: hide it in the
 * restore index, drop its tab from the list, stop the provider (which also aborts a start).
 * In flight until it settles, so a reveal of the same chat waits for it.
 */
export function closeStructuredAgentSessionOnHost(
  runtime: StructuredAgentSessionCloseRuntime,
  sessionId: string,
  cause: StructuredAgentSessionCloseCause,
  request?: StructuredAgentSessionCloseRequest
): Promise<void> {
  return getStructuredAgentSessionClosesInFlight(runtime).commit(
    sessionId,
    async () => {
      if (!getStructuredAgentSessionHost()) {
        await runtime.ensureStructuredAgentSessionHostForClose()
      }
      const host = getStructuredAgentSessionHost()
      if (typeof host?.setSessionTabVisibility === 'function') {
        // The restore index is bookkeeping: one that cannot be written (a newer Orca's records, a
        // failing disk) is reported, and the chat still closes.
        await host.setSessionTabVisibility(sessionId, false).catch((error: unknown) => {
          host.deps.logger.warn('recording a closed chat tab failed', {
            scope: 'tab-visibility-close',
            sessionId,
            error
          })
        })
      }
      try {
        runtime.retireStructuredAgentSessionTabFromSnapshot(sessionId)
      } catch (error) {
        // A throwing snapshot listener must not skip the stop.
        console.warn('[runtime] retiring a closed chat tab failed', sessionId, error)
      }
      if (typeof host?.close === 'function') {
        await host.close(sessionId, cause)
      }
    },
    request
  )
}

/** The worktree a chat belongs to: its record's, else the list that carries it; null if neither. */
function structuredAgentSessionWorktreeId(
  host: Pick<StructuredAgentSessionTabCloseHost, 'mobileSessionTabsByWorktree'>,
  sessionId: string
): string | null {
  const record = getStructuredAgentSessionHost()?.deps.store.getRecord(sessionId)
  if (record) {
    return record.location.workspaceId
  }
  for (const [worktreeId, snapshot] of host.mobileSessionTabsByWorktree) {
    if (findStructuredAgentSessionTab(snapshot, sessionId)) {
      return worktreeId
    }
  }
  return null
}

/** A listed chat: the window closes its own tab first, so its pinned-tab confirm can still veto. */
export async function closeListedStructuredAgentSessionTab(
  host: StructuredAgentSessionTabCloseHost,
  worktreeId: string,
  tab: RuntimeMobileSessionAgentTab,
  options: StructuredAgentSessionTabCloseOptions
): Promise<void> {
  assertOriginalCloseTarget(host, tab.id, options.structuredCloseRequest, tab.sessionId)
  if (host.notifier?.closeSessionTab) {
    try {
      // Why: a reopened chat's window tab id is not derivable from its session; the window maps ours.
      await (options.reason === 'user' && options.originatingWindowId !== undefined
        ? host.notifier.closeSessionTab(tab.id, worktreeId, {
            originatingWindowId: options.originatingWindowId
          })
        : host.notifier.closeSessionTab(tab.id, worktreeId))
    } catch (error) {
      // The renderer already having removed the tab is an idempotent close, not a veto.
      if (!(error instanceof Error && error.message === SESSION_TAB_NOT_FOUND_ERROR)) {
        throw error
      }
    }
  }
  assertOriginalCloseTarget(host, tab.id, options.structuredCloseRequest, tab.sessionId)
  await closeStructuredAgentSessionOnHost(
    host,
    tab.sessionId,
    structuredAgentSessionTabCloseCause(options.reason),
    options.structuredCloseRequest
  )
}

/**
 * Closes the chat `tabId` names in `worktreeId`. An unlisted chat has no window tab to relay to; it
 * still has to stop (and a still-starting one, which may have no record yet, has its start aborted).
 * Throws `agent_session_worktree_mismatch` when the chat belongs to another worktree.
 */
export async function closeStructuredAgentSessionTabForUser(
  host: StructuredAgentSessionTabCloseHost,
  worktreeId: string,
  tabId: string,
  options: StructuredAgentSessionTabCloseOptions
): Promise<void> {
  const cause = structuredAgentSessionTabCloseCause(options.reason)
  const request = options.structuredCloseRequest
  await host.ensureStructuredAgentSessionHostForClose()
  assertOriginalCloseTarget(host, tabId, request)
  const tab = host.mobileSessionTabsByWorktree
    .get(worktreeId)
    ?.tabs.find(
      (candidate): candidate is RuntimeMobileSessionAgentTab =>
        candidate.type === 'agent-session' && candidate.id === tabId
    )
  if (tab) {
    await closeListedStructuredAgentSessionTab(host, worktreeId, tab, options)
    return
  }
  const sessionId = request?.sessionId ?? structuredAgentSessionIdFromHostTabId(tabId)
  if (sessionId === null) {
    throw new Error('tab_not_found')
  }
  const owner = structuredAgentSessionWorktreeId(host, sessionId)
  if (owner !== null && owner !== worktreeId) {
    // Not `tab_not_found`: a client settles that as closed, and this chat is still open elsewhere.
    throw new Error(AGENT_SESSION_WORKTREE_MISMATCH_CODE)
  }
  await closeStructuredAgentSessionOnHost(host, sessionId, cause, request)
}
