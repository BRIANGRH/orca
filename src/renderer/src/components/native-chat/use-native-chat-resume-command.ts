import { useCallback, type Dispatch, type SetStateAction } from 'react'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { parseOrcaNativeChatCommand } from '../../../../shared/native-chat-slash-commands'
import { selectAiVaultPanelWorkspace } from '../right-sidebar/ai-vault-panel-workspace'
import { openAgentSessionHistoryModal } from '../right-sidebar/agent-session-history-modal'
import type { ComposerAutocomplete, NativeChatPickerItem } from './native-chat-composer-state'
import { findNativeChatTabOwnerWorktreeId } from './native-chat-file-link'

export type NativeChatResumeCommand = {
  /** Opens Session History for a `/resume` draft; false means the draft is not Orca's. */
  consume: (draft: string) => boolean
  /** Choosing a draft-leading Orca row runs it; mid-prompt it stays an ordinary completion. */
  interceptPick: <TItem extends NativeChatPickerItem>(
    pick: (item: TItem) => void,
    autocomplete: ComposerAutocomplete
  ) => (item: TItem) => void
}

/** `/resume [search]` opens this chat's Session History and never reaches the agent. */
export function useNativeChatResumeCommand(args: {
  terminalTabId: string
  structuredWorktreeId: string | undefined
  setDraft: (value: string) => void
  setCaret: Dispatch<SetStateAction<number>>
  setActiveSuggestion: Dispatch<SetStateAction<number>>
  clearSkillOrigin: () => void
  setNotice: (notice: string | null) => void
}): NativeChatResumeCommand {
  const { terminalTabId, structuredWorktreeId, setDraft, setCaret } = args
  const { setActiveSuggestion, clearSkillOrigin, setNotice } = args

  const consume = useCallback(
    (draft: string): boolean => {
      const command = parseOrcaNativeChatCommand(draft)
      if (!command) {
        return false
      }
      const state = useAppStore.getState()
      const worktreeId =
        structuredWorktreeId ?? findNativeChatTabOwnerWorktreeId(state, terminalTabId)
      // The chat is on screen, so its workspace is the active one whenever the ids agree.
      const executionHostId =
        worktreeId === state.activeWorktreeId
          ? (state.activeWorkspaceExecutionHostId ?? undefined)
          : undefined
      const workspace = worktreeId
        ? { worktreeId, ...(executionHostId ? { executionHostId } : {}) }
        : null
      // Refuse rather than let "Workspace" silently mean another workspace's history.
      if (!workspace || !selectAiVaultPanelWorkspace(state, workspace).worktree) {
        setNotice(
          translate(
            'components.native-chat.resumeCommand.workspaceUnavailable',
            "This chat's workspace isn't loaded yet. Try /resume again in a moment."
          )
        )
        return true
      }
      openAgentSessionHistoryModal({ workspace, initialQuery: command.argument })
      // Attachments stay armed for the next real prompt.
      setDraft('')
      setCaret(0)
      setActiveSuggestion(0)
      clearSkillOrigin()
      setNotice(null)
      return true
    },
    [
      clearSkillOrigin,
      setActiveSuggestion,
      setCaret,
      setDraft,
      setNotice,
      structuredWorktreeId,
      terminalTabId
    ]
  )

  const interceptPick = useCallback(
    <TItem extends NativeChatPickerItem>(
      pick: (item: TItem) => void,
      autocomplete: ComposerAutocomplete
    ) =>
      (item: TItem) => {
        const leading = autocomplete.mode === 'slash' && autocomplete.dispatchable
        if (leading && item.kind === 'command' && consume(item.token)) {
          return
        }
        pick(item)
      },
    [consume]
  )

  return { consume, interceptPick }
}
