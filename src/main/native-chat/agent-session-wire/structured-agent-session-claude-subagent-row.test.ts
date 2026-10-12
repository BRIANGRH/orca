// A Claude background helper's saved row, from captured frames through the shipping adapter, host
// and child records: its spawn returning and the parent's turn ending leave it working, and only
// its own end frame ends it.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import { isSubagentBlock } from '../../../shared/native-chat-types'
import { activeStructuredAgentSessionTurnId } from '../../../shared/structured-agent-session-live-turn'
import { acpChildWorkStatusSink } from '../../acp/acp-structured-child-work.test-support'
import { RESUMED_BY_MESSAGE } from '../../claude/claude-captured-task-frames.test-fixture'
import { ClaudeStructuredSessionAdapter } from '../../claude/claude-structured-session-adapter'
import {
  claudeStartupSettled,
  fakeClaude,
  PROVIDER_SESSION_ID,
  type FakeConnection
} from '../../claude/claude-structured-session-test-support'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import { structuredClaudeLifecycleEvent } from '../../runtime/structured-claude-runtime-adapter'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import { claudeAndCodexAgents } from './structured-agent-session-adapter-router-test-support'
import { recordingStructuredAgentSessionLogger } from './structured-agent-session-logger-test-support'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  hostTestAttachParams,
  hostTestMessage,
  hostTestOperationId,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'

const CALLER = { callerKey: 'client-1' }

let root: string
let host: StructuredAgentSessionHost
let adapter: ClaudeStructuredSessionAdapter
let store: AgentSessionRecordStore
let claude: ReturnType<typeof fakeClaude>

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-claude-subagent-row-'))
  resetHostTestOperationIds()
  const log = recordingStructuredAgentSessionLogger()
  claude = fakeClaude({ replayUuid: null })
  adapter = new ClaudeStructuredSessionAdapter({
    resolveLaunch: async () => ({
      pathToClaudeCodeExecutable: 'claude',
      options: {},
      cwd: root,
      claudeConfigDir: join(root, 'claude-home'),
      providerSessionId: PROVIDER_SESSION_ID,
      resumeLeafUuid: null,
      resumesTranscript: false,
      continuesChain: false
    }),
    onEvent: (event) => {
      const mapped = structuredClaudeLifecycleEvent(event)
      if (mapped) {
        void host.handleAdapterEvent(mapped)
      }
    },
    onDispatchSettledLate: (settlement) => void host.settleLateDispatch(settlement),
    persistHandle: async () => undefined,
    logger: log.logger,
    onChildWorkEvidence: (sessionId, evidence) =>
      host.publishChildWorkEvidence(sessionId, evidence),
    openConnection: claude.openConnection,
    readProcessStartTime: async () => 1_700_000_000_000,
    now: () => NOW
  })
  store = await openTestAgentSessionRecordStore(root)
  host = new StructuredAgentSessionHost({
    agents: claudeAndCodexAgents(adapter),
    store,
    adapter: Object.assign(adapter, { supportsCreate: () => true }),
    journalDatabase: openTestJournalHostDatabase(root),
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-a',
    logger: log.logger,
    // The host's child records live in a real hook server's store, as in production.
    statusSink: acpChildWorkStatusSink().sink,
    now: () => NOW
  })
  const params = hostTestAttachParams(null, {
    provider: 'claude',
    agent: 'claude',
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: join(root, 'claude-home') },
    providerHandle: { kind: 'claude', sessionId: PROVIDER_SESSION_ID, leafUuid: null }
  })
  expect(await host.attach(CALLER, params)).toMatchObject({ ok: true })
  await claudeStartupSettled(adapter, SESSION)
})

afterEach(async () => {
  await adapter.closeAll()
  await host.flushAllStreamedEvents()
  await rm(root, { recursive: true, force: true })
})

function eventually<T>(assertion: () => T | Promise<T>): Promise<T> {
  return vi.waitFor(assertion, { timeout: 10_000 })
}

function frame(connection: FakeConnection, message: Record<string, unknown>): void {
  connection.handlers.onMessage?.({ session_id: PROVIDER_SESSION_ID, ...message })
}

async function sendAndEcho(connection: FakeConnection, text: string): Promise<void> {
  const body = hostTestMessage(text)
  const sent = await host.send(CALLER, {
    envelope: {
      sessionId: SESSION,
      clientOperationId: hostTestOperationId(),
      expectedRuntimeFence: store.getRecord(SESSION)!.lease.runtimeFence,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.send',
        sessionId: SESSION,
        fields: { body }
      })
    },
    body
  })
  expect(sent.ok).toBe(true)
  await eventually(() =>
    expect(connection.sent.some((message) => JSON.stringify(message).includes(text))).toBe(true)
  )
  frame(connection, { type: 'system', subtype: 'init', uuid: 'init-1', model: 'claude-sonnet-5' })
  frame(connection, { ...connection.sent.at(-1)! })
}

async function savedRows() {
  await host.flushStreamedEvents(SESSION)
  return (await host.journalSnapshot(SESSION)).items.flatMap((item) =>
    item.body.kind === 'message' ? item.body.blocks.filter(isSubagentBlock) : []
  )
}

it("keeps a background helper's row working past its spawn result and its turn's end, until its own end", async () => {
  const connection = claude.connections[0]!
  await sendAndEcho(connection, 'Run it in the background.')
  // Spawn, roster, task start, the spawn's "launched" result, and the parent turn's result.
  for (const [index, captured] of RESUMED_BY_MESSAGE.filter(({ at }) => at <= 4_765).entries()) {
    frame(connection, { uuid: `launch-${index}`, ...captured.frame })
  }
  await eventually(async () => expect(await savedRows()).toHaveLength(1))
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(await savedRows()).toEqual([
    expect.objectContaining({ id: 'agent-1', state: 'working', background: true })
  ])
  const { items } = await host.journalSnapshot(SESSION)
  expect(activeStructuredAgentSessionTurnId(items)).toBeNull()
  expect(items.map((item) => readAgentJournalTurn(item.body)?.state)).toContain('completed')

  // Its own progress, then its own completion.
  for (const [index, captured] of RESUMED_BY_MESSAGE.filter(
    ({ at }) => at > 4_765 && at <= 7_427
  ).entries()) {
    frame(connection, { uuid: `run-${index}`, ...captured.frame })
  }
  await eventually(async () =>
    expect(await savedRows()).toEqual([
      expect.objectContaining({ id: 'agent-1', state: 'completed', tokens: 15_971 })
    ])
  )
})
