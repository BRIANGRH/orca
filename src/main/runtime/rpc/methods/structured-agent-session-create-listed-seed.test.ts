import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionModelCatalogResult } from '../../../../shared/agent-session-wire'
import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-host'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { prepareStructuredAgentSessionCreateForWorktree } from './structured-agent-session-create'

const LISTED: AgentSessionModelCatalogResult = {
  origin: 'probe',
  fetchedAt: 1,
  models: [
    { id: 'sonnet', label: 'Sonnet', isDefault: false, efforts: [{ value: 'low', label: 'Low' }] },
    {
      id: 'opus',
      label: 'Opus',
      isDefault: true,
      efforts: ['low', 'medium', 'high', 'xhigh'].map((value) => ({ value, label: value }))
    }
  ]
}

function prepare(args: {
  agent?: 'claude' | 'codex'
  seed?: Record<string, string>
  catalog?: AgentSessionModelCatalogResult
  options?: Record<string, string>
}) {
  const read = vi.fn(async () => args.catalog ?? LISTED)
  const runtime = {
    resolveStructuredAgentSessionCreateIntent: vi.fn(async (input: { envelope: unknown }) => ({
      envelope: input.envelope,
      location: {
        executionHostId: 'local',
        wslDistro: null,
        workspaceId: 'w',
        workspaceKind: 'git-worktree'
      },
      provider: args.agent ?? 'claude',
      agent: args.agent ?? 'claude',
      accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/host/.claude' },
      runtimeKind: 'native',
      ...(args.seed ? { options: args.seed } : {})
    })),
    resolveStructuredAgentSessionLocalWorkspacePath: vi.fn(async () => '/repo')
  }
  const host = {
    deps: {
      modelCatalog: { read },
      store: { getOperationRow: () => null },
      agents: { definition: () => ({ restingOptions: { acceptsKey: () => true } }) }
    }
  }
  const prepared = prepareStructuredAgentSessionCreateForWorktree({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: prepare calls only the two runtime methods stubbed here.
    runtime: runtime as unknown as OrcaRuntimeService,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: prepare reads only these host deps.
    ensureHost: async () => host as unknown as StructuredAgentSessionHost,
    envelope: {
      sessionId: 'claude:s1',
      clientOperationId: 'op-1',
      expectedRuntimeFence: null,
      payloadFingerprint: 'fp'
    },
    worktree: 'id:w',
    agent: args.agent ?? 'claude',
    caller: { callerKey: 'caller' },
    atRest: true,
    ...(args.options ? { options: args.options } : {})
  })
  return { prepared, read }
}

describe('a new chat whose remembered Claude model the saved list no longer offers', () => {
  it('starts on the listed default, its effort moved to the nearest level offered', async () => {
    const { prepared, read } = prepare({ seed: { model: 'gone', effort: 'max', fastMode: 'true' } })
    expect((await prepared).attachParams.options).toEqual({
      model: 'opus',
      effort: 'xhigh',
      fastMode: 'true'
    })
    expect(read).toHaveBeenCalledWith({ agent: 'claude', workspacePath: '/repo', savedOnly: true })
  })

  it('keeps a remembered model the list offers', async () => {
    const { prepared } = prepare({ seed: { model: 'sonnet', effort: 'low' } })
    expect((await prepared).attachParams.options).toEqual({ model: 'sonnet', effort: 'low' })
  })

  it('keeps the remembered model while no list is saved', async () => {
    const { prepared } = prepare({ seed: { model: 'gone' }, catalog: { origin: 'unknown' } })
    expect((await prepared).attachParams.options).toEqual({ model: 'gone' })
  })

  it('runs an explicit model exactly as given, as `--model` does', async () => {
    const { prepared, read } = prepare({ seed: { model: 'gone' }, options: { model: 'also-gone' } })
    expect((await prepared).attachParams.options).toEqual({ model: 'also-gone' })
    expect(read).not.toHaveBeenCalled()
  })

  it('leaves other agents alone', async () => {
    const { prepared, read } = prepare({ agent: 'codex', seed: { model: 'gone' } })
    expect((await prepared).attachParams.options).toEqual({ model: 'gone' })
    expect(read).not.toHaveBeenCalled()
  })
})
