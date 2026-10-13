import { parseCliVersion } from '../../shared/app-version'
import type { CodexAppServerConnection } from './codex-app-server-connection-types'

const HANDSHAKE_TIMEOUT_MS = 15_000

/** Codex's own version from its `initialize` answer, whose `userAgent` leads with
 *  `<originator>/<version>`; null when it names none. */
export function codexVersionFromInitialize(answer: unknown): string | null {
  const userAgent =
    typeof answer === 'object' && answer !== null && 'userAgent' in answer
      ? answer.userAgent
      : undefined
  return typeof userAgent === 'string' ? parseCliVersion(userAgent.split(/\s/, 1)[0]) : null
}

/** Handshakes and answers the Codex version the child reported, or null. */
export async function initializeCodexAppServerConnection(
  connection: Pick<CodexAppServerConnection, 'request' | 'notify'>
): Promise<string | null> {
  const answer = await connection.request(
    'initialize',
    {
      clientInfo: { name: 'orca_desktop', title: 'Orca', version: '0.0.0' },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        mcpServerOpenaiFormElicitation: false,
        extensions: {}
      }
    },
    { timeoutMs: HANDSHAKE_TIMEOUT_MS }
  )
  connection.notify('initialized')
  return codexVersionFromInitialize(answer)
}
