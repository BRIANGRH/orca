import { useMemo } from 'react'
import { translate } from '@/i18n/i18n'
import type { AgentType } from '../../../../shared/agent-status-types'
import { getVerifiedNativeChatCommands } from '../../../../shared/native-chat-agent-profiles'
import {
  sessionReportedSkillNames,
  sessionSlashCommandSuggestions,
  withOrcaNativeChatCommands,
  type SlashCommandSuggestion
} from '../../../../shared/native-chat-slash-commands'
import { structuredSlashCommands } from '../../../../shared/structured-agent-session-composer'
import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'

export type NativeChatComposerCatalog = {
  agentCommands: readonly SlashCommandSuggestion[]
  sessionSkillNames: readonly string[] | undefined
}

function localizedOrcaCommands(): readonly SlashCommandSuggestion[] {
  return [
    {
      name: 'resume',
      description: translate(
        'components.native-chat.resumeCommand.description',
        'Open Agent Session History'
      ),
      argumentHint: translate('components.native-chat.resumeCommand.argumentHint', '[search]')
    }
  ]
}

/**
 * What the `/` menu offers. A structured session reports the surface it actually
 * loaded — the only list that includes this repo's own commands and the skills
 * that reach the session through plugin roots — so it wins whenever it is
 * present. The curated per-agent catalog remains the answer for the PTY lane and
 * for a host that predates the report. Orca's rows join after that choice.
 */
export function useNativeChatComposerCatalog(
  agent: AgentType,
  structuredTransport?: NativeChatStructuredComposerTransport
): NativeChatComposerCatalog {
  const structured = Boolean(structuredTransport)
  const reported = structuredTransport?.sessionCommands
  const conversationCommands = structuredTransport?.conversationCommands
  const agentCommands = useMemo(
    () =>
      withOrcaNativeChatCommands(
        !structured
          ? getVerifiedNativeChatCommands(agent)
          : reported !== undefined
            ? sessionSlashCommandSuggestions(agent, reported)
            : structuredSlashCommands(conversationCommands, agent),
        localizedOrcaCommands()
      ),
    [agent, conversationCommands, reported, structured]
  )
  const sessionSkillNames = useMemo(
    () => (reported !== undefined ? sessionReportedSkillNames(reported) : undefined),
    [reported]
  )
  return { agentCommands, sessionSkillNames }
}
