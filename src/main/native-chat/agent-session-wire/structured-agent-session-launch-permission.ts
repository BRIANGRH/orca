// The permission mode a chat's agent starts with: its saved choice, narrowed by what the host's
// model catalog lists for the chat's model. A start launches with it and the child keeps it.

import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import {
  AGENT_CHAT_PERMISSION_MODE_OPTION_ID,
  chatPermissionModeNeedsModelSupport,
  effectiveChatPermissionMode,
  type AgentChatPermissionMode
} from '../../../shared/agent-chat-permission-mode'
import type { StructuredAgentSessionHostDeps } from './structured-agent-session-host-types'

export type StructuredAgentSessionLaunchPermission = {
  mode: AgentChatPermissionMode
  /** False when the mode rests on a model the saved catalog does not describe. */
  known: boolean
}

/** Saved catalog only: a start never waits on a listing. Matches the model by id, or the listed
 *  default when the chat names none. */
async function listedAutoModeSupport(
  catalog: StructuredAgentSessionHostDeps['modelCatalog'],
  record: AgentSessionRecord
): Promise<boolean | undefined> {
  const listing = await catalog
    ?.read({ agent: record.provider, sessionId: record.sessionId, savedOnly: true })
    .catch(() => null)
  if (!listing || listing.origin === 'unknown') {
    return undefined
  }
  const model = record.options?.model
  const row = listing.models.find((entry) =>
    model === undefined || model === 'default' ? entry.isDefault : entry.id === model
  )
  return row?.supportsAutoMode
}

/** Null for an agent whose chats offer no modes. */
export async function structuredAgentSessionLaunchPermission(
  deps: Pick<StructuredAgentSessionHostDeps, 'agents' | 'modelCatalog'>,
  record: AgentSessionRecord
): Promise<StructuredAgentSessionLaunchPermission | null> {
  const support = deps.agents.definition(record.provider)?.permissionModes
  if (!support) {
    return null
  }
  const intent = record.options?.[AGENT_CHAT_PERMISSION_MODE_OPTION_ID]
  if (!chatPermissionModeNeedsModelSupport(support, intent)) {
    return { mode: effectiveChatPermissionMode(support, intent, false), known: true }
  }
  const supported = await listedAutoModeSupport(deps.modelCatalog, record)
  return {
    mode: effectiveChatPermissionMode(support, intent, supported === true),
    known: supported !== undefined
  }
}
