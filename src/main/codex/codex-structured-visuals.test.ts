import { describe, expect, it, vi } from 'vitest'
import type { NativeChatVisualsLaunch } from '../native-chat/native-chat-visuals-delivery'
import { CodexAppServerRequestError } from './codex-app-server-request-error'
import { CodexAppServerTimeoutError } from './codex-app-server-session'
import { acquired, fakeCodex, THREAD_ID } from './codex-structured-session-adapter-fixture'
import { CODEX_VISUALS_SETUP_BUDGET_MS, setUpCodexVisualsSkill } from './codex-structured-visuals'
import { codexStructuredPermissionPolicy } from './codex-structured-permission-policy'

const VISUALS: NativeChatVisualsLaunch = {
  skill: { pluginDir: '/app/native-chat-visuals', skillsRoot: '/app/native-chat-visuals/skills' }
}
const MANUAL = codexStructuredPermissionPolicy('ask')

type Call = { method: string; params?: Record<string, unknown>; timeoutMs?: number }

function connectionAnswering(routes: Record<string, () => unknown>) {
  const calls: Call[] = []
  const request = vi.fn(
    async (method: string, params?: Record<string, unknown>, options?: { timeoutMs?: number }) => {
      calls.push({ method, params, timeoutMs: options?.timeoutMs })
      const route = routes[method]
      return route ? route() : {}
    }
  )
  return { calls, connection: { request } }
}

describe('setting up a Codex app-server for a chat with visuals', () => {
  it('names only the skill root; pages go in the workspace the sandbox already writes', async () => {
    const { calls, connection } = connectionAnswering({})
    await setUpCodexVisualsSkill(connection, VISUALS, { sessionId: 's-1' })
    expect(calls).toEqual([
      {
        method: 'skills/extraRoots/set',
        params: { extraRoots: [VISUALS.skill.skillsRoot] },
        timeoutMs: CODEX_VISUALS_SETUP_BUDGET_MS
      }
    ])
  })

  it('opens without the skill on a Codex that predates skill roots, or one that fails or hangs', async () => {
    const failures = [
      new CodexAppServerRequestError(
        'skills/extraRoots/set',
        -32600,
        'Invalid request: unknown variant `skills/extraRoots/set`, expected one of `initialize`'
      ),
      new CodexAppServerRequestError('skills/extraRoots/set', -32601, 'method not found'),
      new CodexAppServerTimeoutError('codex app-server skills/extraRoots/set exceeded 2000ms'),
      new Error('broken pipe')
    ]
    for (const failure of failures) {
      const logger = { warn: vi.fn(), error: vi.fn() }
      const { connection } = connectionAnswering({
        'skills/extraRoots/set': () => Promise.reject(failure)
      })
      await expect(
        setUpCodexVisualsSkill(connection, VISUALS, { logger, sessionId: 's-1' })
      ).resolves.toBeUndefined()
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringMatching(
          failure.message.includes('variant') || failure.message.includes('not found')
            ? /cannot load skills/
            : /did not take/
        ),
        expect.objectContaining({ scope: 'nativeChatVisuals.codex', error: failure })
      )
    }
  })

  it('sends nothing for a chat without visuals', async () => {
    const { calls, connection } = connectionAnswering({})
    await setUpCodexVisualsSkill(connection, null, { sessionId: 's-1' })
    expect(calls).toEqual([])
  })
})

describe('a Codex chat acquisition with visuals', () => {
  it('names the skill root after initialize and before the thread opens, on start and resume', async () => {
    for (const resumeThreadId of [null, THREAD_ID]) {
      const codex = fakeCodex()
      await acquired(codex, { visuals: VISUALS, permissionPolicy: MANUAL, resumeThreadId })
      const connection = codex.connections[0]!
      const methods = connection.calls.map((call) => call.method)
      const open = resumeThreadId ? 'thread/resume' : 'thread/start'
      expect(methods.indexOf('skills/extraRoots/set')).toBeLessThan(methods.indexOf(open))
      expect(connection.calls.find((call) => call.method === open)?.params).not.toHaveProperty(
        'config'
      )
    }
  })

  it('opens the thread exactly as before for a chat without visuals', async () => {
    const codex = fakeCodex()
    await acquired(codex, { permissionPolicy: MANUAL })
    const connection = codex.connections[0]!
    const methods = connection.calls.map((call) => call.method)
    expect(methods[0]).toBe('thread/start')
    expect(methods).not.toContain('skills/extraRoots/set')
    expect(connection.calls[0]?.params).not.toHaveProperty('config')
  })
})
