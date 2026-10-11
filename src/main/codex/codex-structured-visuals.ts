// Inline visuals for a Codex chat, set up on its app-server between initialize and the thread
// open: the skill root Codex scans. The agent writes pages into the chat's workspace, which its
// sandbox already lets it write. Best effort under a short budget; a chat whose setup fails, hangs
// or is unsupported opens without visuals.

import type { NativeChatVisualsLaunch } from '../native-chat/native-chat-visuals-delivery'
import type { StructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'
import type { CodexAppServerConnection } from './codex-app-server-connection'
import { isCodexAppServerRequestError } from './codex-app-server-request-error'
import { isCodexMethodNotFoundError } from './codex-app-server-session'

/** Why short: the request answers from local state in milliseconds, and the user's first prompt
 *  waits behind it; past this the thread opens without the skill. */
export const CODEX_VISUALS_SETUP_BUDGET_MS = 2_000

const SKILL_ROOTS_METHOD = 'skills/extraRoots/set'

type CodexVisualsConnection = Pick<CodexAppServerConnection, 'request'>

/** A Codex that predates the method: older builds refuse it as an unknown request variant. */
function isSkillRootsUnsupported(error: unknown): boolean {
  return (
    isCodexMethodNotFoundError(error) ||
    (isCodexAppServerRequestError(error) &&
      error.code === -32600 &&
      error.message.includes(`unknown variant \`${SKILL_ROOTS_METHOD}\``))
  )
}

/**
 * The skill roots Orca hands this app-server. The request replaces the process's whole list, so
 * every root Orca supplies is named here; each chat has its own app-server, and this runs on every
 * acquisition, so a respawned or resumed chat gets the list again.
 */
function orcaSkillRoots(visuals: NativeChatVisualsLaunch): string[] {
  return [visuals.skill.skillsRoot]
}

async function setSkillRoots(
  connection: CodexVisualsConnection,
  visuals: NativeChatVisualsLaunch,
  report: (message: string, error: unknown) => void
): Promise<void> {
  try {
    await connection.request(
      SKILL_ROOTS_METHOD,
      { extraRoots: orcaSkillRoots(visuals) },
      { timeoutMs: CODEX_VISUALS_SETUP_BUDGET_MS }
    )
  } catch (error) {
    report(
      isSkillRootsUnsupported(error)
        ? 'codex app-server cannot load skills by path; the chat has no visuals skill'
        : 'codex app-server did not take the visuals skill root',
      error
    )
  }
}

/** Hands this app-server the chat's visuals skill root. Codex reads skill roots when a thread
 *  opens, so this runs between initialize and the open. Never throws. */
export async function setUpCodexVisualsSkill(
  connection: CodexVisualsConnection,
  visuals: NativeChatVisualsLaunch | null | undefined,
  log: { logger?: StructuredAgentSessionLogger; sessionId: string }
): Promise<void> {
  if (!visuals) {
    return
  }
  await setSkillRoots(connection, visuals, (message, error) =>
    log.logger?.warn(message, {
      scope: 'nativeChatVisuals.codex',
      sessionId: log.sessionId,
      ...(error === null ? {} : { error })
    })
  )
}
