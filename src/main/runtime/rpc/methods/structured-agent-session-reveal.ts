// `agentSession.reveal` — republishing the tab for a chat that still exists on disk.
//
// A surface can hold nothing but a session id: an Agent Session History row names a chat this
// process may never have published, because `close` keeps the record and the journal but not the
// tab, and a client drops every unpublished `agent-session` tab on each session-tabs sync. Without
// this the row is unreachable, and the client's "retry in a moment" is advice that never comes true.
//
// Distinct from `agentSession.ensure`, which attaches a location the CLIENT supplies. Here the host
// reads its own record and answers with that record's workspace and provider, so a client knowing
// only a session id cannot aim the publication somewhere else.

import {
  agentSessionRefusalFromReference,
  isAgentSessionRefusalError,
  isAgentSessionWireRefusalCode
} from '../../../../shared/agent-session-wire'
import type { StructuredAgentSessionReveal } from '../../../native-chat/agent-session-wire/structured-agent-session-host-types'
import { refuseAgentSessionMutation } from '../../../native-chat/agent-session-wire/structured-agent-session-mutation-admission'
import { defineMethod } from '../core'
import {
  ensureStructuredHostInstalled,
  requireStructuredCapability,
  requireStructuredAgentAudience,
  requireStructuredHost
} from './structured-agent-session-gate'
import { OptionsParams } from './structured-agent-session-schemas'
import {
  getStructuredAgentSessionClosesInFlight,
  STRUCTURED_AGENT_SESSION_CLOSE_WAIT_MS
} from '../../structured-agent-session-closes-in-flight'
import { AGENT_SESSION_CLOSE_PENDING_CODE } from '../../../../shared/session-tab-close'

/** Under the window's own 5 s reveal timeout, so the host never publishes after the window gave up;
 *  a close held past it (a pinned-tab confirm can take minutes) fails the reveal rather than racing. */
export const STRUCTURED_AGENT_SESSION_REVEAL_CLOSE_WAIT_MS = STRUCTURED_AGENT_SESSION_CLOSE_WAIT_MS

export const STRUCTURED_AGENT_SESSION_REVEAL_METHODS = [
  defineMethod({
    name: 'agentSession.reveal',
    permission: 'workspace',
    params: OptionsParams,
    handler: async (params, ctx) => {
      requireStructuredCapability(ctx)
      // Why first: a reveal published before an earlier close of the same chat ends is retired by it.
      // Waits for every close of the chat in flight while it waits, including ones that begin later.
      const closes = getStructuredAgentSessionClosesInFlight(ctx.runtime)
      return closes.runPublication(params.sessionId, async (signal) => {
        if (
          !(await closes.settled(params.sessionId, STRUCTURED_AGENT_SESSION_REVEAL_CLOSE_WAIT_MS))
        ) {
          // Thrown, not refused: a client reads a refusal as the chat being gone or the host too old.
          throw new Error(AGENT_SESSION_CLOSE_PENDING_CODE)
        }
        await ensureStructuredHostInstalled(ctx)
        if (signal.aborted) {
          throw new Error(AGENT_SESSION_CLOSE_PENDING_CODE)
        }
        let revealed: StructuredAgentSessionReveal
        try {
          const host = requireStructuredHost(ctx)
          requireStructuredAgentAudience(ctx, host.sessionAgent(params.sessionId) ?? '')
          revealed = await host.revealSession(params.sessionId)
        } catch (error) {
          // The host raises its refusal as the code itself; anything else is a genuine fault and
          // must not be laundered into a tidy "no such chat".
          const code = error instanceof Error ? error.message : ''
          if (!isAgentSessionWireRefusalCode(code)) {
            throw error
          }
          return refuseAgentSessionMutation(
            agentSessionRefusalFromReference(
              isAgentSessionRefusalError(error) ? error.refusal : { code },
              code === 'structured_agent_session_unsupported'
                ? 'This host cannot open that chat.'
                : 'This chat is no longer on this host.'
            )
          )
        }
        if (signal.aborted) {
          throw new Error(AGENT_SESSION_CLOSE_PENDING_CODE)
        }
        await ctx.runtime.publishStructuredAgentSessionTab({
          workspaceId: revealed.workspaceId,
          sessionId: revealed.sessionId,
          agent: revealed.agent,
          activate: true,
          signal
        })
        if (signal.aborted) {
          throw new Error(AGENT_SESSION_CLOSE_PENDING_CODE)
        }
        // Named fields only: the host's reasons a journal did not open stay on the host.
        const { sessionId, workspaceId, agent, readable } = revealed
        return { ok: true as const, sessionId, workspaceId, agent, readable }
      })
    }
  })
]
