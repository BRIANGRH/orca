// What a structured chat launch gets for inline visuals: where this host keeps the skill that
// teaches the reply line. The agent writes its pages into the chat's own workspace like any other
// file, so there is no folder or permission to prepare. Best effort: a chat without it still starts.

import type { StructuredAgentSessionLogger } from './agent-session-wire/structured-agent-session-logger'
import {
  resolveNativeChatVisualsSkillLocation,
  type NativeChatVisualsSkillLocation
} from './native-chat-visuals-skill-location'

export type NativeChatVisualsLaunch = {
  skill: NativeChatVisualsSkillLocation
}

/** Prepares one chat's launch; null leaves the chat without visuals. Never throws. */
export type PrepareNativeChatVisuals = (
  sessionId: string
) => Promise<NativeChatVisualsLaunch | null>

export function createNativeChatVisualsDelivery(deps: {
  logger: StructuredAgentSessionLogger
  isEnabled?: () => boolean
  resolveSkill?: () => Promise<NativeChatVisualsSkillLocation | null>
}): PrepareNativeChatVisuals {
  const resolveSkill = deps.resolveSkill ?? (() => resolveNativeChatVisualsSkillLocation())
  return async (sessionId) => {
    try {
      if (deps.isEnabled?.() === false) {
        return null
      }
      const skill = await resolveSkill()
      if (!skill) {
        deps.logger.warn('native-chat visuals skill is missing from this install', {
          scope: 'nativeChatVisuals.skill',
          sessionId
        })
        return null
      }
      return { skill }
    } catch (error) {
      deps.logger.warn('native-chat visuals skill could not be prepared', {
        scope: 'nativeChatVisuals.skill',
        sessionId,
        error
      })
      return null
    }
  }
}
