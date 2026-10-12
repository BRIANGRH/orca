import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import * as fsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ensureSessionParseCacheLoaded,
  flushSessionParseCachePersistForTests,
  initSessionParseCachePersistence,
  resetSessionParseCachePersistenceForTests,
  scheduleSessionParseCachePersist
} from './session-parse-cache-persistence'
import { scanAiVaultSessions } from './session-scanner'
import {
  createSessionParseStats,
  resetSessionParseCacheForTests,
  snapshotSessionParseCacheForPersistence
} from './session-scanner-parse-cache'
import type * as ParseCacheModule from './session-scanner-parse-cache'
import { isolatedScanRoots } from './session-scanner-test-fixtures'

const hooks = vi.hoisted(() => {
  const state: { afterParse: (() => void) | null } = { afterParse: null }
  return state
})

vi.mock('node:fs/promises', { spy: true })
vi.mock('./session-scanner-parse-cache', async (importOriginal) => {
  const actual = await importOriginal<typeof ParseCacheModule>()
  return {
    ...actual,
    parseAgentSessionFileCached: async (
      ...args: Parameters<typeof actual.parseAgentSessionFileCached>
    ) => {
      const session = await actual.parseAgentSessionFileCached(...args)
      hooks.afterParse?.()
      return session
    }
  }
})

const APP_VERSION = '1.2.3-test'
let tempRoots: string[] = []

beforeEach(() => {
  resetSessionParseCacheForTests()
  resetSessionParseCachePersistenceForTests()
  hooks.afterParse = null
})

afterEach(async () => {
  vi.useRealTimers()
  resetSessionParseCachePersistenceForTests()
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

async function writeClaudeHistory(projectDir: string, count: number): Promise<void> {
  await mkdir(projectDir, { recursive: true })
  for (let index = 0; index < count; index++) {
    const sessionId = `aaaaaaaa-bbbb-4ccc-8ddd-${String(index).padStart(12, '0')}`
    const record = {
      type: 'user',
      sessionId,
      timestamp: new Date(1740000000000 + index * 60_000).toISOString(),
      cwd: '/repo/app',
      message: { role: 'user', content: `question ${index}` }
    }
    await writeFile(join(projectDir, `${sessionId}.jsonl`), `${JSON.stringify(record)}\n`)
  }
}

describe('session parse cache checkpoints', () => {
  it('a cancelled scan keeps the files it finished for the next launch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-parse-cache-checkpoint-'))
    tempRoots.push(root)
    const cacheFile = join(root, 'session-parse-cache.json')
    initSessionParseCachePersistence({ filePath: cacheFile, appVersion: APP_VERSION })
    const roots = isolatedScanRoots(root)
    await writeClaudeHistory(join(roots.claudeProjectsDir, 'project'), 20)
    const controller = new AbortController()
    let parsed = 0
    // Cancel once the first batch of eight has parsed, as a timeout or a
    // superseding refresh would mid-scan.
    hooks.afterParse = () => {
      if (++parsed === 8) {
        controller.abort()
      }
    }

    await expect(scanAiVaultSessions({ ...roots, signal: controller.signal })).rejects.toThrow()
    await flushSessionParseCachePersistForTests()

    // A fresh launch on the same profile: only the checkpoint on disk remains.
    resetSessionParseCacheForTests()
    resetSessionParseCachePersistenceForTests()
    initSessionParseCachePersistence({ filePath: cacheFile, appVersion: APP_VERSION })
    await ensureSessionParseCacheLoaded()
    expect(snapshotSessionParseCacheForPersistence()).toHaveLength(8)
  })

  it('a long run of parse batches saves every max-wait window, not only after the last one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-parse-cache-checkpoint-'))
    tempRoots.push(root)
    initSessionParseCachePersistence({
      filePath: join(root, 'session-parse-cache.json'),
      appVersion: APP_VERSION
    })
    const stats = { ...createSessionParseStats(), fullParses: 1 }
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    vi.mocked(fsPromises.rename).mockClear()

    // A batch finishing every second keeps re-arming the 1.5 s debounce.
    for (let second = 0; second < 20; second++) {
      scheduleSessionParseCachePersist(stats)
      await vi.advanceTimersByTimeAsync(1_000)
    }
    vi.useRealTimers()
    await vi.waitFor(() => expect(fsPromises.rename).toHaveBeenCalledTimes(1))

    await flushSessionParseCachePersistForTests()
    expect(fsPromises.rename).toHaveBeenCalledTimes(2)
  })
})
