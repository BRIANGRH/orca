import type { LucideIcon } from 'lucide-react'
import { FilePenLine, Hand, ShieldAlert, ShieldCheck } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import type { AgentChatPermissionMode } from '../../../../shared/agent-chat-permission-mode'

export const NATIVE_CHAT_PERMISSION_MODE_ICONS = {
  ask: Hand,
  'accept-edits': FilePenLine,
  auto: ShieldCheck,
  'full-access': ShieldAlert
} as const satisfies Record<AgentChatPermissionMode, LucideIcon>

export function nativeChatPermissionModeLabel(mode: AgentChatPermissionMode): string {
  switch (mode) {
    case 'ask':
      return translate('components.native-chat.composer.permissionAsk', 'Ask for approval')
    case 'accept-edits':
      return translate('components.native-chat.composer.permissionAcceptEdits', 'Accept edits')
    case 'auto':
      return translate('components.native-chat.composer.permissionAuto', 'Approve for me')
    case 'full-access':
      return translate('components.native-chat.composer.permissionFullAccess', 'Full access')
  }
}

/** `agent` absent describes the mode for every agent, as the new-chat setting does. */
export function nativeChatPermissionModeDescription(
  mode: AgentChatPermissionMode,
  agent?: string | null
): string {
  switch (mode) {
    case 'ask':
      if (agent === 'codex') {
        return translate(
          'components.native-chat.composer.permissionAskCodexDescription',
          'Works inside the workspace sandbox; asks before going beyond it'
        )
      }
      if (agent !== 'claude') {
        return translate(
          'components.native-chat.composer.permissionAskSharedDescription',
          'Claude asks unless your settings allow it; Codex asks beyond the workspace sandbox'
        )
      }
      return translate(
        'components.native-chat.composer.permissionAskDescription',
        "Asks before edits and commands your settings don't allow"
      )
    case 'accept-edits':
      return translate(
        'components.native-chat.composer.permissionAcceptEditsDescription',
        'Approves file edits and file commands; asks for the rest'
      )
    case 'auto':
      return translate(
        'components.native-chat.composer.permissionAutoDescription',
        'Reviews approval requests for you'
      )
    case 'full-access':
      if (agent === 'codex') {
        return translate(
          'components.native-chat.composer.permissionFullAccessCodexDescription',
          'Never asks; no sandbox'
        )
      }
      if (agent !== 'claude') {
        return translate(
          'components.native-chat.composer.permissionFullAccessSharedDescription',
          'Skips approval prompts; Codex also runs without its sandbox'
        )
      }
      return translate(
        'components.native-chat.composer.permissionFullAccessDescription',
        'Skips approval prompts; your Claude rules and sandbox still apply'
      )
  }
}

export function nativeChatPermissionPickerTitle(): string {
  return translate('components.native-chat.composer.permissions', 'Permissions')
}
