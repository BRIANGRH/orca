import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import * as fsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  flushSessionParseCachePersistForTests,
  initSessionParseCachePersistence,
  resetSessionParseCachePersistenceForTests,
  scheduleSessionParseCachePersist
} from './session-parse-cache-persistence'
import { scanAiVaultSessions } from './session-scanner'
import {
  createSessionParseStats,
  resetSessionParseCacheForTests
} from './session-scanner-parse-cache'
import type * as ParseCacheModule from './session-scanner-parse-cache'
import { isolatedScanRoots } from './session-scanner-test-fixtures'

const hooks = vi.hoisted(() => {
  const state: { beforeParse: (() => Promise<void>) | null } = { beforeParse: null }
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
      await hooks.beforeParse?.()
      return actual.parseAgentSessionFileCached(...args)
    }
  }
})

const APP_VERSION = '1.2.3-test'
let tempRoots: string[] = []

beforeEach(() => {
  resetSessionParseCacheForTests()
  resetSessionParseCachePersistenceForTests()
  hooks.beforeParse = null
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
  it('a scan saves the files it finished while it is still running', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-parse-cache-checkpoint-'))
    tempRoots.push(root)
    const cacheFile = join(root, 'session-parse-cache.json')
    initSessionParseCachePersistence({ filePath: cacheFile, appVersion: APP_VERSION })
    const roots = isolatedScanRoots(root)
    await writeClaudeHistory(join(roots.claudeProjectsDir, 'project'), 20)
    let started = 0
    let release = (): void => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    // Hold everything after the first batch of eight, as a scan still running
    // when its deadline kills it would be.
    hooks.beforeParse = () => (++started > 8 ? held : Promise.resolve())

    const scan = scanAiVaultSessions(roots)
    await vi.waitFor(() => expect(existsSync(cacheFile)).toBe(true), {
      timeout: 10_000,
      interval: 50
    })
    release()
    expect((await scan).sessions).toHaveLength(20)
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
