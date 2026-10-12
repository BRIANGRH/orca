import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { agentJournalTurnBody } from '../../../shared/agent-session-turn-record'
import type { AgentChildWorkRowView } from '../../../shared/agent-status-child-work-view'
import { isSubagentBlock } from '../../../shared/native-chat-types'
import { claudeProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-host-database-test-support'
import { StructuredAgentSessionSubagentRows } from './structured-agent-session-subagent-rows'

const journals = createTrackedJournalOpener()
let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-subagent-rows-'))
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

function child(overrides: Partial<AgentChildWorkRowView> = {}): AgentChildWorkRowView {
  return {
    id: 'record-1',
    providerId: 'agent-1',
    kind: 'agent',
    description: 'Audit the build',
    state: 'working',
    membership: 'live',
    firstObservedAt: 100,
    observedAt: 100,
    stoppable: true,
    invocation: { invocationId: 'toolu_1', generation: 1 },
    residency: 'background',
    ...overrides
  }
}

async function rig() {
  const journal: AgentSessionJournal = await journals.open({
    identity: {
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'claude',
      providerHandle: claudeProviderHandle('claude-session', null)
    },
    now: () => 9_000,
    stateDirectory: root
  })
  let children: AgentChildWorkRowView[] = []
  const failed = vi.fn()
  const rows = new StructuredAgentSessionSubagentRows({
    journal: () => journal,
    fence: () => 1,
    readChildWork: () => children,
    onWriteFailed: failed
  })
  const report = async (next: AgentChildWorkRowView[]) => {
    children = next
    rows.changed('session-1')
    // The writer is a queued loop; one macrotask lets its writes land.
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  const saved = () =>
    journal
      .snapshot()
      .items.flatMap((item) =>
        item.body.kind === 'message'
          ? item.body.blocks.filter(isSubagentBlock).map((block) => ({ item, block }))
          : []
      )
  const openTurn = (turnId: string) =>
    journal.appendItem(
      { provider: 'legacy', agent: 'claude', sessionId: 'session-1', recordId: `turn:${turnId}` },
      agentJournalTurnBody({ turnId, state: 'running', startedAt: 50 }),
      { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
  return {
    journal,
    report,
    saved,
    openTurn,
    failed,
    fail: (value: boolean) => {
      if (value) {
        vi.spyOn(journal, 'appendItem').mockRejectedValue(new Error('disk full'))
      } else {
        vi.mocked(journal.appendItem).mockRestore()
      }
    }
  }
}

describe("each subagent's saved row", () => {
  it('writes one row per subagent, where it was spawned, and none for other work', async () => {
    const r = await rig()
    await r.openTurn('turn-1')
    await r.report([
      child(),
      child({ id: 'record-2', providerId: 'agent-2', description: 'Read the docs' }),
      child({ id: 'record-3', providerId: 'shell-1', kind: 'command' })
    ])
    const rows = r.saved()
    expect(rows.map(({ block }) => [block.id, block.label, block.state])).toEqual([
      ['agent-1', 'Audit the build', 'working'],
      ['agent-2', 'Read the docs', 'working']
    ])
    expect(rows.map(({ item }) => item.turnScope?.kind)).toEqual(['turn', 'turn'])
    expect(rows[0]?.block).toMatchObject({ run: 'toolu_1', background: true, startedAt: 100 })
  })

  it('writes nothing for a record its row already says', async () => {
    const r = await rig()
    await r.report([child()])
    const [first] = r.saved()
    await r.report([child({ observedAt: 150, stoppable: false })])
    expect(r.saved()).toEqual([first])
  })

  it('revises the row in place: same item, same spawn place, the new ending', async () => {
    const r = await rig()
    await r.openTurn('turn-1')
    await r.report([child()])
    const [before] = r.saved()
    await r.openTurn('turn-2')
    await r.report([
      child({
        membership: 'settled',
        state: 'done',
        outcome: 'cancelled',
        outcomeBasis: 'stop-acknowledged',
        settledAt: 300
      })
    ])
    const [after] = r.saved()
    expect(after?.item.itemId).toBe(before?.item.itemId)
    expect(after?.item.sequence).toBe(before?.item.sequence)
    expect(after?.item.turnScope).toEqual(before?.item.turnScope)
    expect(after?.block).toMatchObject({
      groupId: before?.block.groupId,
      state: 'stopped',
      settledAt: 300,
      outcomeBasis: 'stop-acknowledged'
    })
  })

  it('starts a new run’s clock when the host first saw that run', async () => {
    const r = await rig()
    await r.report([child()])
    await r.report([
      child({ observedAt: 400, invocation: { invocationId: 'toolu_2', generation: 2 } })
    ])
    expect(r.saved()[0]?.block).toMatchObject({ run: 'toolu_2', startedAt: 400 })
  })

  it('reports a failed write and writes the row on the next change', async () => {
    const r = await rig()
    r.fail(true)
    await r.report([child()])
    expect(r.failed).toHaveBeenCalledWith('session-1', expect.any(Error))
    expect(r.saved()).toEqual([])
    r.fail(false)
    await r.report([child({ totalTokens: 20 })])
    expect(r.saved().map(({ block }) => block.tokens)).toEqual([20])
  })
})
