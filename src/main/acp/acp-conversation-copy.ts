// "Resume in New CLI" for an ACP agent whose CLI has no copy flag: the agent copies the chat's
// conversation over its chat protocol, and the terminal opens the copy with a plain resume, so the
// CLI never becomes a second writer on the conversation the chat owns.

import type { AgentSessionJournalIdentity } from '../../shared/agent-session-journal-types'
import { AcpRpcError } from './acp-errors'
import { acpAgentName } from './acp-structured-agent-definitions'
import type { AcpStructuredConnection } from './acp-structured-connection'
import type { AcpStructuredSessionAdapterDeps } from './acp-structured-session-adapter-deps'

/** Bounds a copy, which is one request: past it the agent is closed and the copy fails. */
export const ACP_CONVERSATION_COPY_TIMEOUT_MS = 60_000

/**
 * Copies provider conversation `providerSessionId` of the chat `identity` names into a new one the
 * agent saves, and answers the copy's id. A short-lived agent runs under the chat's own launch
 * (binary, account, environment and folder), whether or not the chat's agent is running: both read
 * the same saved conversation, and only the copy is written.
 */
export async function copyAcpConversation(
  deps: Pick<AcpStructuredSessionAdapterDeps, 'spec' | 'readLaunch' | 'connect'>,
  input: { identity: AgentSessionJournalIdentity; providerSessionId: string },
  timeoutMs = ACP_CONVERSATION_COPY_TIMEOUT_MS
): Promise<string> {
  const name = acpAgentName(deps.spec.agent)
  let connection: AcpStructuredConnection | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${name} did not answer in time.`)), timeoutMs)
  })
  try {
    // Unsealed: it runs no turn, so it carries none of the chat's identity, and no pane's either.
    const launch = await deps.readLaunch(input.identity)
    connection = deps.connect(
      {
        command: launch.command,
        args: launch.args,
        cwd: launch.cwd,
        env: launch.env,
        envToDelete: launch.envToDelete
      },
      { clientInfo: { name: 'orca', version: '1' } }
    )
    return await Promise.race([
      forkAdvertised(connection, input.providerSessionId, launch.cwd),
      timedOut
    ])
  } catch (error) {
    throw new Error(
      error instanceof AcpRpcError && error.code === -32601
        ? `This ${name} version cannot copy a chat. Update ${name} to resume this chat in a new CLI.`
        : `${name} could not copy this chat.`,
      { cause: error }
    )
  } finally {
    clearTimeout(timer)
    await connection?.close().catch(() => false)
  }
}

/** `session/fork`, asked only of an agent that advertises it; -32601 (no such method) otherwise. */
async function forkAdvertised(
  connection: AcpStructuredConnection,
  sessionId: string,
  cwd: string
): Promise<string> {
  const { agentCapabilities } = await connection.initialize()
  if (agentCapabilities?.sessionCapabilities?.fork == null) {
    throw new AcpRpcError(-32601, 'session/fork is not advertised')
  }
  return connection.forkSession(sessionId, cwd)
}
