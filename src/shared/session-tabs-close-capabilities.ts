// The capabilities that gate how a client closes a tab on its host.

// Why: an older host answers `tab_not_found` to `session.tabs.close` for a chat it does not list,
// so it never stops a still-starting chat; a client sends the parallel `agentSession.close` there.
export const SESSION_TABS_CLOSE_AGENT_SESSION_BY_ID_RUNTIME_CAPABILITY =
  'session-tabs.close-agent-session-by-id.v1' as const
