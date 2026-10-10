// The chat's permission mode as a picker descriptor: shows the mode the host states, never derives it.

import {
  AGENT_CHAT_PERMISSION_MODE_OPTION_ID,
  agentChatPermissionModes,
  offeredChatPermissionModes,
  type AgentChatPermissionMode
} from './agent-chat-permission-mode'
import type { AgentSessionOptionCatalog } from './agent-session-option-catalog'
import { resolveEffectiveNativeChatModelId } from './native-chat-session-option-snapshot'
import type { NativeChatSessionOptionRecord } from './native-chat-session-option-state'
import type { SessionOptionDescriptor } from './native-chat-session-options'

/** English names and descriptions for surfaces without a translation catalog. */
const MODE_COPY: Readonly<Record<AgentChatPermissionMode, { label: string; description: string }>> =
  {
    ask: {
      label: 'Ask for approval',
      description: "Asks before edits and commands your settings don't allow"
    },
    'accept-edits': {
      label: 'Accept edits',
      description: 'Approves file edits and file commands; asks for the rest'
    },
    auto: { label: 'Approve for me', description: 'Reviews approval requests for you' },
    'full-access': {
      label: 'Full access',
      description: 'Skips approval prompts; your Claude rules and sandbox still apply'
    }
  }

const CODEX_DESCRIPTIONS: Partial<Record<AgentChatPermissionMode, string>> = {
  ask: 'Works inside the workspace sandbox; asks before going beyond it',
  'full-access': 'Never asks; no sandbox'
}

/** Only decides whether the menu offers Approve for me; unknown reads as no. */
function currentModelSupportsAutoMode(
  catalog: AgentSessionOptionCatalog | null,
  record: NativeChatSessionOptionRecord
): boolean {
  if (!catalog) {
    return false
  }
  const modelId = resolveEffectiveNativeChatModelId(catalog, catalog.models, record)
  return catalog.models.find((model) => model.id === modelId)?.supportsAutoMode === true
}

export function structuredAgentSessionPermissionDescriptor(state: {
  catalog: AgentSessionOptionCatalog | null
  record: NativeChatSessionOptionRecord
  permissionMode: string | null
}): SessionOptionDescriptor | null {
  const support = agentChatPermissionModes(state.record.agent)
  const current = support?.modes.find((mode) => mode === state.permissionMode)
  if (!support || !current) {
    return null
  }
  const offered = offeredChatPermissionModes(
    support,
    current === 'auto' || currentModelSupportsAutoMode(state.catalog, state.record)
  )
  return {
    id: AGENT_CHAT_PERMISSION_MODE_OPTION_ID,
    label: 'Permissions',
    category: 'mode',
    kind: {
      type: 'select',
      currentValue: current,
      choices: offered.map((value) => ({
        value,
        label: MODE_COPY[value].label,
        description:
          (state.record.agent === 'codex' ? CODEX_DESCRIPTIONS[value] : undefined) ??
          MODE_COPY[value].description
      }))
    },
    valueSource: 'applied',
    transport: 'agent-session',
    settable: true
  }
}
