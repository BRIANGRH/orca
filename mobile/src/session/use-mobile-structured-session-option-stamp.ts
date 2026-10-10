import { useCallback, useSyncExternalStore } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import { mobileStructuredSessionStatusFeed } from './mobile-structured-session-status-feed'

const noSubscription = (): (() => void) => () => {}

/**
 * The option values the host's status carries for session `sessionId`, as one stamp: a pick made
 * on another device moves it, so the phone re-reads the session's options, as the desktop does.
 * Off `enabled` (no status feed or no connection), it never moves.
 */
export function useMobileStructuredSessionOptionStamp(args: {
  client: RpcClient | null
  sessionId: string | null
  enabled: boolean
}): string {
  const { client, sessionId, enabled } = args
  const feed = enabled && client && sessionId ? mobileStructuredSessionStatusFeed(client) : null
  const subscribe = useCallback(
    (listener: () => void) => (feed ? feed.subscribe(listener) : noSubscription()),
    [feed]
  )
  const readStamp = (): string => {
    const summary = feed && sessionId ? feed.getSnapshot().get(sessionId) : undefined
    return `${summary?.model ?? ''}|${summary?.permissionMode ?? ''}`
  }
  return useSyncExternalStore(subscribe, readStamp, readStamp)
}
