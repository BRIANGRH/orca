import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import { structuredAgentSessionIdFromHostTabId } from '../../structured-agent-session-tab-close'
import type { RpcContext } from '../core'
import { assertProjectedSessionTabVisible } from './session-tab-browser-placement-projection'
import { assertAgentSessionTabDestructiveMutationSupported } from './session-tab-agent-status-projection'
import { projectSessionTabsForClient } from './session-tabs-inventory'
import {
  clientRendersStructuredAgent,
  supportsStructuredAgentSessions
} from './structured-agent-session-policy'

/** A chat the host does not list may be closed by id only by a client that would render it. */
function clientMayCloseUnlistedChat(context: RpcContext, sessionId: string): boolean {
  const agent = getStructuredAgentSessionHost()?.sessionAgent(sessionId)
  return agent
    ? clientRendersStructuredAgent(context.clientCapabilities, agent)
    : supportsStructuredAgentSessions(context)
}

/**
 * The remote-client gate of `session.tabs.close`; the local window passes it too. Throws
 * `tab_not_found` for a tab this client cannot see. A chat's check reads the stored list without
 * the terminal process scan, and a chat the host does not list passes, for the close by session id.
 */
export async function admitRemoteSessionTabClose(
  params: { worktree: string; tabId: string },
  context: RpcContext,
  receiptSessionId?: string
): Promise<void> {
  if (!context.clientKind) {
    return
  }
  const sessionId = receiptSessionId ?? structuredAgentSessionIdFromHostTabId(params.tabId)
  if (sessionId !== null && supportsStructuredAgentSessions(context)) {
    await context.runtime.ensureStructuredAgentSessionHostForClose()
  }
  const raw =
    sessionId === null
      ? await context.runtime.listMobileSessionTabs(params.worktree, context.pairedDeviceId)
      : await context.runtime.listMobileSessionTabsForChatClose(
          params.worktree,
          context.pairedDeviceId
        )
  if (
    sessionId !== null &&
    !raw.tabs.some((tab) => tab.id === params.tabId) &&
    clientMayCloseUnlistedChat(context, sessionId)
  ) {
    return
  }
  const visible = projectSessionTabsForClient(raw, context.clientKind, context.clientCapabilities)
  assertProjectedSessionTabVisible(visible, params.tabId)
  assertAgentSessionTabDestructiveMutationSupported(
    raw,
    params.tabId,
    context.clientKind,
    context.clientCapabilities
  )
}
