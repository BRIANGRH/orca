import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CLI_CONVERSATION_ADOPTING_AGENTS } from '../../shared/structured-agent-cli-conversation-adoption'
import {
  STRUCTURED_AGENT_RUNTIME_REGISTRATIONS,
  structuredAgentRuntimeRegistration
} from '../runtime/structured-agent-runtime-registrations'
import { resolveStructuredAgentSessionAdoptionForCreate } from '../runtime/structured-agent-session-create-adoption'
import { prepareLegacyTranscriptImport } from './agent-session-journal/journal-legacy-import'

const SESSION_ID = '0198c2a4-7d1e-7c3a-9a4b-1f2e3d4c5b6a'
let root: string | null = null

afterEach(async () => {
  vi.unstubAllEnvs()
  if (root) {
    await rm(root, { recursive: true, force: true })
  }
  root = null
})

/** Each agent's CLI conversation as its own CLI lays it out under an account home. */
const RECORDED: Record<'grok' | 'omp', (home: string, text: string) => Promise<string>> = {
  grok: async (home, text) => {
    const dir = join(home, 'sessions', encodeURIComponent('/repo/orca'), SESSION_ID)
    await mkdir(dir, { recursive: true })
    const file = join(dir, 'chat_history.jsonl')
    await writeFile(
      file,
      `${JSON.stringify({ type: 'user', content: [{ type: 'text', text }], timestamp: '2026-10-12T00:00:00.000Z' })}\n`
    )
    return file
  },
  omp: async (home, text) => {
    const dir = join(home, 'sessions', '--repo-orca--')
    await mkdir(dir, { recursive: true })
    const file = join(dir, `2026-10-12T00-00-00-000Z_${SESSION_ID}.jsonl`)
    await writeFile(
      file,
      [
        {
          type: 'session',
          id: SESSION_ID,
          cwd: '/repo/orca',
          timestamp: '2026-10-12T00:00:00.000Z'
        },
        {
          type: 'message',
          id: 'rec-1',
          parentId: null,
          timestamp: '2026-10-12T00:00:01.000Z',
          message: { role: 'user', content: [{ type: 'text', text }] }
        }
      ]
        .map((record) => JSON.stringify(record))
        .join('\n')
    )
    return file
  }
}

function adopt(agent: 'grok' | 'omp', selectedAccountHomePath: string) {
  // Grok also looks where Session History lists it from; keep that off the real home.
  vi.stubEnv('GROK_HOME', selectedAccountHomePath)
  const transcriptImport = structuredAgentRuntimeRegistration(agent)?.transcriptImport
  if (!transcriptImport) {
    throw new Error(`${agent} registers no transcript import`)
  }
  return resolveStructuredAgentSessionAdoptionForCreate({
    host: null,
    settings: {},
    agent,
    transcriptImport,
    providerSessionId: SESSION_ID,
    selfSessionId: 'chat-1',
    selectedAccountHomePath
  })
}

describe('which chats can take over a CLI conversation', () => {
  it('lists exactly the agents the host registers a transcript import for', () => {
    expect(
      STRUCTURED_AGENT_RUNTIME_REGISTRATIONS.filter((registration) => registration.transcriptImport)
        .map((registration) => registration.definition.agent)
        .toSorted()
    ).toEqual([...CLI_CONVERSATION_ADOPTING_AGENTS].toSorted())
  })
})

describe.each(['grok', 'omp'] as const)('adopting a %s CLI conversation', (agent) => {
  it('finds the conversation under the chat account and imports its history', async () => {
    root = await mkdtemp(join(tmpdir(), `orca-${agent}-adopt-`))
    const recorded = await RECORDED[agent](root, `ORCA-${agent}-ADOPT`)

    const adoption = await adopt(agent, root)

    expect(adoption).toEqual({ accountHomePath: root, transcriptPath: recorded })
    const imported = await prepareLegacyTranscriptImport({
      agent,
      sessionId: SESSION_ID,
      options: { filePath: adoption.transcriptPath }
    })
    expect(imported.ok && JSON.stringify(imported.items)).toContain(`ORCA-${agent}-ADOPT`)
  })

  it('refuses a conversation the account does not hold, rather than opening a blank chat', async () => {
    root = await mkdtemp(join(tmpdir(), `orca-${agent}-adopt-missing-`))
    await expect(adopt(agent, root)).rejects.toMatchObject({
      refusal: { code: 'agent_session_identity_required' }
    })
  })
})
