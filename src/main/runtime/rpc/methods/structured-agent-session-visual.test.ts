import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../../../shared/agent-session-record'
import { agentSessionRecordFixture } from '../../../../shared/agent-session-record.test-fixture'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import { ALL_RPC_METHODS } from '.'
import { STRUCTURED_AGENT_SESSION_VISUAL_METHODS } from './structured-agent-session-visual'
import {
  call as callStructured,
  clearStructuredHostStub,
  hostStub,
  SESSION,
  STRUCTURED_CLIENT
} from './structured-agent-session-rpc.test-fixture'

type CallClient = Parameters<typeof callStructured>[2]

function call(method: string, params: unknown, client: CallClient) {
  return callStructured(method, params, client, {}, STRUCTURED_AGENT_SESSION_VISUAL_METHODS)
}

let root: string
let record: AgentSessionRecord | null
const resolveWorkspacePath = vi.fn(async (workspaceId: string) => join(root, workspaceId))

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-visual-rpc-'))
  record = { ...agentSessionRecordFixture(), sessionId: SESSION }
  resolveWorkspacePath.mockClear()
  setStructuredAgentSessionHost(
    Object.assign(hostStub(), {
      deps: {
        store: { getRecord: (id: string) => (record?.sessionId === id ? record : null) },
        resolveWorkspacePath
      }
    })
  )
})

afterEach(async () => {
  clearStructuredHostStub()
  await rm(root, { recursive: true, force: true })
})

/** Writes a page into the chat's workspace, the folder the host resolves for its record. */
async function writeVisual(path: string, html: string, folder?: string): Promise<void> {
  const target = join(folder ?? join(root, record?.location.workspaceId ?? ''), path)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, html)
}

describe('agentSession.readVisual', () => {
  it('is registered on the runtime manifest', () => {
    expect(ALL_RPC_METHODS.map((method) => method.name)).toContain('agentSession.readVisual')
  })

  it("reads a page from the chat's workspace", async () => {
    await writeVisual('reports/chart.html', '<p>chart</p>')
    const reply = await call(
      'agentSession.readVisual',
      { sessionId: SESSION, path: 'reports/chart.html' },
      STRUCTURED_CLIENT
    )
    expect(reply).toMatchObject({
      ok: true,
      result: { ok: true, html: '<p>chart</p>', sizeBytes: 12 }
    })
    expect(resolveWorkspacePath).toHaveBeenCalledWith(record?.location.workspaceId)
  })

  it('reads a floating chat from the folder it was pinned to', async () => {
    const base = agentSessionRecordFixture()
    const pinned = join(root, 'pinned-folder')
    record = {
      ...base,
      sessionId: SESSION,
      location: { ...base.location, workspaceId: FLOATING_TERMINAL_WORKTREE_ID },
      launchDirectory: pinned
    }
    await writeVisual('chart.html', '<p>pinned</p>', pinned)
    const reply = await call(
      'agentSession.readVisual',
      { sessionId: SESSION, path: 'chart.html' },
      STRUCTURED_CLIENT
    )
    expect(reply).toMatchObject({ ok: true, result: { ok: true, html: '<p>pinned</p>' } })
    expect(resolveWorkspacePath).not.toHaveBeenCalled()
  })

  it('answers unchanged for the revision the client holds', async () => {
    await writeVisual('chart.html', '<p>chart</p>')
    const first = await call(
      'agentSession.readVisual',
      { sessionId: SESSION, path: 'chart.html' },
      STRUCTURED_CLIENT
    )
    const result: unknown = first.ok ? first.result : null
    const revision =
      typeof result === 'object' && result !== null && 'revision' in result
        ? String(result.revision)
        : ''
    const again = await call(
      'agentSession.readVisual',
      { sessionId: SESSION, path: 'chart.html', knownRevision: revision },
      STRUCTURED_CLIENT
    )
    expect(again).toMatchObject({ ok: true, result: { ok: true, unchanged: true, revision } })
    const againResult: unknown = again.ok ? again.result : null
    expect(typeof againResult === 'object' && againResult !== null && 'html' in againResult).toBe(
      false
    )
  })

  it('reports a session this host has no record of', async () => {
    record = null
    const reply = await call(
      'agentSession.readVisual',
      { sessionId: SESSION, path: 'chart.html' },
      STRUCTURED_CLIENT
    )
    expect(reply).toMatchObject({ ok: true, result: { ok: false, error: 'session_not_found' } })
  })

  it('refuses a chat recorded on another execution host or a WSL distro', async () => {
    const base = agentSessionRecordFixture()
    record = {
      ...base,
      sessionId: SESSION,
      location: { ...base.location, executionHostId: 'ssh:box' }
    }
    const ssh = await call(
      'agentSession.readVisual',
      { sessionId: SESSION, path: 'chart.html' },
      STRUCTURED_CLIENT
    )
    expect(ssh).toMatchObject({ ok: true, result: { ok: false, error: 'unsupported_location' } })

    record = { ...base, sessionId: SESSION, location: { ...base.location, wslDistro: 'Ubuntu' } }
    const wsl = await call(
      'agentSession.readVisual',
      { sessionId: SESSION, path: 'chart.html' },
      STRUCTURED_CLIENT
    )
    expect(wsl).toMatchObject({ ok: true, result: { ok: false, error: 'unsupported_location' } })
  })

  it.each([
    ['an escaping path', { sessionId: SESSION, path: '../chart.html' }],
    ['an absolute path', { sessionId: SESSION, path: '/etc/chart.html' }],
    ['a non-html file', { sessionId: SESSION, path: 'chart.txt' }],
    ['a bad session id', { sessionId: '../x', path: 'chart.html' }],
    ['a legacy file name that is a path', { sessionId: SESSION, file: 'reports/chart.html' }],
    ['both path and file', { sessionId: SESSION, path: 'chart.html', file: 'chart.html' }],
    ['a malformed revision', { sessionId: SESSION, path: 'chart.html', knownRevision: 'zz' }]
  ])('rejects %s as invalid params', async (_name, params) => {
    const reply = await call('agentSession.readVisual', params, STRUCTURED_CLIENT)
    expect(reply).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
  })

  it('answers a legacy file read as not found: only an older host keeps per-chat visuals', async () => {
    await writeVisual('chart.html', '<p>chart</p>')
    const reply = await call(
      'agentSession.readVisual',
      { sessionId: SESSION, file: 'chart.html' },
      STRUCTURED_CLIENT
    )
    expect(reply).toMatchObject({ ok: true, result: { ok: false, error: 'not_found' } })
  })

  it('is refused to a client that cannot read structured sessions', async () => {
    await writeVisual('chart.html', '<p>chart</p>')
    const reply = await call(
      'agentSession.readVisual',
      { sessionId: SESSION, path: 'chart.html' },
      { clientKind: 'runtime', clientCapabilities: [] }
    )
    expect(reply.ok).toBe(false)
  })
})
