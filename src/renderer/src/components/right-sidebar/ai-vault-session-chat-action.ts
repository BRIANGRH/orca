import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import type { AiVaultSearchHit } from '../../../../shared/ai-vault-search-types'
import type { AiVaultOriginalPaneTarget } from './ai-vault-original-pane'
import { canResumeAiVaultSearchHit } from './ai-vault-search-session'
import type { AiVaultSessionResumeState } from './ai-vault-session-resume'
import type { AiVaultResumeInChatEligibility } from './ai-vault-session-resume-in-chat'
import {
  resolveAiVaultSessionSurfaceSwitchTargets,
  type AiVaultSessionSurfaceSwitchTargets
} from './ai-vault-session-surface-switch'

export type AiVaultSessionRowChatActions = AiVaultSessionSurfaceSwitchTargets & {
  /** The session is already open in a pane, so opening it means switching there. */
  canJumpToOriginalPane: boolean
}

/** Shared by a row's buttons and keyboard Enter, so Enter never reaches an action the row hides. */
export function resolveAiVaultSessionRowChatActions(args: {
  session: AiVaultSession
  originalPaneTarget: AiVaultOriginalPaneTarget | null
  structuredSessionOpen: boolean
  resumeState: AiVaultSessionResumeState | null
  resumeInChat: AiVaultResumeInChatEligibility | null
  searchHit: AiVaultSearchHit | undefined
}): AiVaultSessionRowChatActions {
  const searchResumeAllowed = args.searchHit ? canResumeAiVaultSearchHit(args.searchHit) : true
  const targets = resolveAiVaultSessionSurfaceSwitchTargets(
    args.session,
    args.resumeState,
    args.resumeInChat
  )
  return {
    canJumpToOriginalPane: Boolean(args.originalPaneTarget) || args.structuredSessionOpen,
    resumeInNewChatWorkspaceId: searchResumeAllowed ? targets.resumeInNewChatWorkspaceId : null,
    resumeInNewCliWorktreeId: searchResumeAllowed ? targets.resumeInNewCliWorktreeId : null
  }
}
