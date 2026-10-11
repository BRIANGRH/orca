export const SESSION_TAB_CLOSE_CANCELED_ERROR = 'session_tab_close_canceled'
export const SESSION_TAB_CLOSE_FAILED_ERROR = 'session_tab_close_failed'
export const SESSION_TAB_NOT_FOUND_ERROR = 'session_tab_not_found'
export const SESSION_TAB_CLOSE_TIMEOUT_ERROR = 'session_tab_close_timeout'
/** A host chat close named a worktree other than the chat's own; nothing was stopped. */
export const AGENT_SESSION_WORKTREE_MISMATCH_CODE = 'agent_session_worktree_mismatch'
/** A reveal gave up waiting for an in-flight close of the same chat; nothing was published. */
export const AGENT_SESSION_CLOSE_PENDING_CODE = 'agent_session_close_pending'

export type SessionTabCloseRequest = {
  requestId: string
  tabId: string
  worktreeId: string
  expiresAt?: number
}

export type SessionTabCloseResponse = {
  requestId: string
  error?: string
}
