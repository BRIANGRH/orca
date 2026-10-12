import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionProviderHandle } from '../../shared/agent-session-provider-handle'
import type { AiVaultPrepareSessionResumeArgs } from '../../shared/ai-vault-resume-preparation'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { copyStructuredChatConversation } from './structured-chat-conversation-copy'
import { installCopyingChat as installChat } from './structured-session-ownership.test-support'

const OMP_ID = '019fd611-2b3c-7d4e-9f50-6b7c8d9e0f1a'
const OPENCODE_ID = 'ses_2f9aB3cD4eF5gH6iJ7kL8mN9oP'
const OMP_FILE = `/Users/me/.omp/agent/sessions/--Users-me-repo--/2026-10-09T10-00-00-000Z_${OMP_ID}.jsonl`

const acp = (agent: 'opencode' | 'omp', nativeId: string): AgentSessionProviderHandle => ({
  transport: 'acp',
  agent,
  nativeId
})

const fork = (
  overrides: Partial<AiVaultPrepareSessionResumeArgs>
): AiVaultPrepareSessionResumeArgs => ({
  agent: 'omp',
  sessionId: OMP_ID,
  filePath: OMP_FILE,
  codexHome: null,
  executionHostId: 'local',
  fork: true,
  ...overrides
})

afterEach(() => setStructuredAgentSessionHost(null))

describe('copying a chat conversation for Resume in New CLI', () => {
  it.each([
    { agent: 'omp' as const, handle: acp('omp', OMP_ID), sessionId: OMP_ID },
    { agent: 'opencode2' as const, handle: acp('opencode', OPENCODE_ID), sessionId: OPENCODE_ID }
  ])(
    "has the chat's host copy a $agent row's conversation",
    async ({ agent, handle, sessionId }) => {
      const copy = vi.fn(async () => 'copy-1')
      installChat(handle, copy)

      await expect(
        copyStructuredChatConversation(fork({ agent, sessionId, filePath: `/x/${sessionId}` }))
      ).resolves.toEqual({ useRealCodexHome: false, forkedSessionId: 'copy-1' })
      expect(copy).toHaveBeenCalledWith({
        identity: {
          sessionId: 'chat-1',
          workspaceId: 'workspace-1',
          hostId: 'local',
          agent: handle.agent,
          providerHandle: handle
        },
        providerSessionId: sessionId
      })
    }
  )

  it('leaves a resume, and a fork its CLI makes, to the usual preparation', async () => {
    const copy = vi.fn(async () => 'copy-1')
    installChat(acp('omp', OMP_ID), copy)

    await expect(copyStructuredChatConversation(fork({ fork: false }))).resolves.toBeNull()
    await expect(
      copyStructuredChatConversation(fork({ agent: 'claude', sessionId: 'c1' }))
    ).resolves.toBeNull()
    expect(copy).not.toHaveBeenCalled()
  })

  it('refuses when no chat owns the row any more, never copying another', async () => {
    const copy = vi.fn(async () => 'copy-1')
    installChat(acp('omp', OMP_ID), copy)

    await expect(
      copyStructuredChatConversation(fork({ sessionId: 'other', filePath: '/x/other.jsonl' }))
    ).rejects.toThrow('This chat is no longer in Orca')
    setStructuredAgentSessionHost(null)
    await expect(copyStructuredChatConversation(fork({}))).rejects.toThrow(
      'This chat is no longer in Orca'
    )
    expect(copy).not.toHaveBeenCalled()
  })

  it("passes the agent's refusal through", async () => {
    installChat(
      acp('omp', OMP_ID),
      vi.fn(async () => {
        throw new Error('OMP could not copy this chat.')
      })
    )

    await expect(copyStructuredChatConversation(fork({}))).rejects.toThrow(
      'OMP could not copy this chat.'
    )
  })
})
