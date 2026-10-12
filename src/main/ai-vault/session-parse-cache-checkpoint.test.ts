import { existsSync } from 'node:fs'
import { appendFile, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
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
  const state: {
    beforeParse: (() => Promise<void>) | null
    stats: ParseCacheModule.SessionParseStats | null
  } = { beforeParse: null, stats: null }
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
      hooks.stats = args[2] ?? null
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
  hooks.stats = null
})

afterEach(async () => {
  vi.useRealTimers()
  resetSessionParseCachePersistenceForTests()
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

async function writeClaudeHistory(projectDir: string, count: number): Promise<string[]> {
  await mkdir(projectDir, { recursive: true })
  const paths: string[] = []
  for (let index = 0; index < count; index++) {
    const sessionId = `aaaaaaaa-bbbb-4ccc-8ddd-${String(index).padStart(12, '0')}`
    const record = {
      type: 'user',
      sessionId,
      timestamp: new Date(1740000000000 + index * 60_000).toISOString(),
      cwd: '/repo/app',
      message: { role: 'user', content: `question ${index}` }
    }
    const path = join(projectDir, `${sessionId}.jsonl`)
    await writeFile(path, `${JSON.stringify(record)}\n`)
    const modified = new Date(1740000000000 + index * 60_000)
    await utimes(path, modified, modified)
    paths.push(path)
  }
  return paths
}

function paceScanBatches(delayMs: number): void {
  let started = 0
  hooks.beforeParse = async () => {
    if (++started % 8 === 1) {
      await vi.advanceTimersByTimeAsync(delayMs)
    }
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
    try {
      await vi.waitFor(() => expect(existsSync(cacheFile)).toBe(true), {
        timeout: 10_000,
        interval: 50
      })
      expect(JSON.parse(await readFile(cacheFile, 'utf8')).entries).toHaveLength(8)
    } finally {
      release()
    }
    expect((await scan).sessions).toHaveLength(20)
  })

  it('caps continuous save requests and starts a fresh debounce after flush', async () => {
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
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    scheduleSessionParseCachePersist(stats)
    await vi.advanceTimersByTimeAsync(1_499)
    expect(fsPromises.rename).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    await flushSessionParseCachePersistForTests()
    expect(fsPromises.rename).toHaveBeenCalledTimes(3)
    resetSessionParseCachePersistenceForTests()
    scheduleSessionParseCachePersist(stats)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(fsPromises.rename).toHaveBeenCalledTimes(3)
  })

  it.each([1_000, 2_000])(
    'saves once after a changed batch and an unchanged tail paced at %i ms',
    async (delayMs) => {
      const root = await mkdtemp(join(tmpdir(), 'orca-parse-cache-checkpoint-'))
      tempRoots.push(root)
      const roots = isolatedScanRoots(root)
      const paths = await writeClaudeHistory(join(roots.claudeProjectsDir, 'project'), 160)
      await scanAiVaultSessions(roots)
      await appendFile(paths[159], '\n')
      const cacheFile = join(root, 'session-parse-cache.json')
      initSessionParseCachePersistence({ filePath: cacheFile, appVersion: APP_VERSION })
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
      vi.mocked(fsPromises.rename).mockClear()
      vi.mocked(fsPromises.writeFile).mockClear()
      paceScanBatches(delayMs)

      expect((await scanAiVaultSessions(roots)).sessions).toHaveLength(160)
      await flushSessionParseCachePersistForTests()
      expect(fsPromises.writeFile).toHaveBeenCalledTimes(1)
      expect(fsPromises.rename).toHaveBeenCalledTimes(1)
      expect(JSON.parse(await readFile(cacheFile, 'utf8')).entries).toHaveLength(160)
      expect(hooks.stats?.reused).toBe(159)
      expect(hooks.stats?.incremental).toBe(1)
    }
  )

  it('checkpoints recurring changed batches during a real scan and flushes its final batch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-parse-cache-checkpoint-'))
    tempRoots.push(root)
    const roots = isolatedScanRoots(root)
    await writeClaudeHistory(join(roots.claudeProjectsDir, 'project'), 328)
    const cacheFile = join(root, 'session-parse-cache.json')
    initSessionParseCachePersistence({ filePath: cacheFile, appVersion: APP_VERSION })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    vi.mocked(fsPromises.rename).mockClear()
    paceScanBatches(1_000)

    expect((await scanAiVaultSessions(roots)).sessions).toHaveLength(328)
    vi.useRealTimers()
    await vi.waitFor(() => expect(fsPromises.rename).toHaveBeenCalledTimes(2))
    await flushSessionParseCachePersistForTests()
    expect(fsPromises.rename).toHaveBeenCalledTimes(3)
    expect(JSON.parse(await readFile(cacheFile, 'utf8')).entries).toHaveLength(328)
    expect(hooks.stats?.fullParses).toBe(328)
    expect(hooks.stats?.reused).toBe(0)
  })
})
