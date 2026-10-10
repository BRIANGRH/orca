import type { GlobalSettings } from './global-settings-types'
import { resolveAgentPermissionModeSummary } from './tui-agent-permissions'

/** A chat's own permission choice. Saved in chat records and settings: never rename a value. */
export type AgentChatPermissionMode = 'ask' | 'accept-edits' | 'auto' | 'full-access'

/** Picker order: least to most access. */
export const AGENT_CHAT_PERMISSION_MODES = [
  'ask',
  'accept-edits',
  'auto',
  'full-access'
] as const satisfies readonly AgentChatPermissionMode[]

/** The chat option a mode is saved and written under. */
export const AGENT_CHAT_PERMISSION_MODE_OPTION_ID = 'permissionMode'

export function isAgentChatPermissionMode(value: unknown): value is AgentChatPermissionMode {
  return AGENT_CHAT_PERMISSION_MODES.some((mode) => mode === value)
}

/** The modes one agent's chats offer. */
export type AgentChatPermissionModeSupport = {
  modes: readonly AgentChatPermissionMode[]
  /** `auto` runs only on a model the agent's listing says supports it. */
  autoNeedsModelSupport?: true
}

export const CLAUDE_CHAT_PERMISSION_MODES: AgentChatPermissionModeSupport = {
  modes: AGENT_CHAT_PERMISSION_MODES,
  autoNeedsModelSupport: true
}

export const CODEX_CHAT_PERMISSION_MODES: AgentChatPermissionModeSupport = {
  modes: ['ask', 'auto', 'full-access']
}

/** Null for an agent whose chats have no picker: it keeps following Agent Permissions. */
export function agentChatPermissionModes(agent: string): AgentChatPermissionModeSupport | null {
  return agent === 'claude'
    ? CLAUDE_CHAT_PERMISSION_MODES
    : agent === 'codex'
      ? CODEX_CHAT_PERMISSION_MODES
      : null
}

/** The saved choice if this agent offers it; anything else asks, never grants more access. */
export function savedChatPermissionMode(
  support: AgentChatPermissionModeSupport,
  intent: unknown
): AgentChatPermissionMode {
  return support.modes.find((mode) => mode === intent) ?? 'ask'
}

/** Whether the mode a chat runs depends on its model's listed `auto` support. */
export function chatPermissionModeNeedsModelSupport(
  support: AgentChatPermissionModeSupport,
  intent: unknown
): boolean {
  return (
    support.autoNeedsModelSupport === true && savedChatPermissionMode(support, intent) === 'auto'
  )
}

/** What a chat runs and shows: its saved choice, with `auto` on a model not listed for it read as
 *  Ask. Derived on every read and never written back, so a supporting model gets `auto` again. */
export function effectiveChatPermissionMode(
  support: AgentChatPermissionModeSupport,
  intent: unknown,
  autoSupported: boolean
): AgentChatPermissionMode {
  const mode = savedChatPermissionMode(support, intent)
  return mode === 'auto' && support.autoNeedsModelSupport && !autoSupported ? 'ask' : mode
}

export function offeredChatPermissionModes(
  support: AgentChatPermissionModeSupport,
  autoSupported: boolean
): readonly AgentChatPermissionMode[] {
  return support.autoNeedsModelSupport && !autoSupported
    ? support.modes.filter((mode) => mode !== 'auto')
    : support.modes
}

/** The host's new-chat default as an agent's chat starts with it; null for an agent with none. */
export function newChatPermissionMode(
  agent: string,
  setting: unknown
): AgentChatPermissionMode | null {
  const support = agentChatPermissionModes(agent)
  return support ? savedChatPermissionMode(support, setting) : null
}

/** The new-chat default as loaded. Seeded once from Agent Permissions when absent; once stored it
 *  no longer follows them. An unknown value from another build asks. */
export function loadedChatPermissionSetting(
  saved: unknown,
  terminal: Partial<Pick<GlobalSettings, 'agentDefaultArgs' | 'agentDefaultEnv'>>
): AgentChatPermissionMode {
  if (saved !== undefined) {
    return isAgentChatPermissionMode(saved) ? saved : 'ask'
  }
  return resolveAgentPermissionModeSummary(terminal) === 'yolo' ? 'full-access' : 'ask'
}
