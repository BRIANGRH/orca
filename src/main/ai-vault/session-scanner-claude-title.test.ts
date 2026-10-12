import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { scanAiVaultSessions } from './session-scanner'
import { isolatedScanRoots, writeJsonlFile } from './session-scanner-test-fixtures'
import {
  stoppedHistoryElement,
  stoppedHistoryFrame
} from '../native-chat/agent-session-wire/structured-agent-session-stopped-history-frame'

let tempRoots: string[] = []

/** The frame a native chat's send carries one stopped message in. */
function stoppedFrame(text: string): string {
  return stoppedHistoryFrame({
    elements: [
      stoppedHistoryElement({ number: 1, text, images: { first: 1, count: 0 }, omittedImages: 0 })
    ],
    notIncluded: 0,
    shortened: 0,
    sendImages: { first: 1, count: 0 }
  })
}

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

describe('scanAiVaultSessions Claude title selection', () => {
  it('prefers the latest generated ai-title over the first user prompt, but a custom-title wins over both', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-ai-title-'))
    tempRoots.push(root)
    const roots = isolatedScanRoots(root)
    const projectDir = join(roots.claudeProjectsDir, 'project')

    await writeJsonlFile(join(projectDir, 'generated.jsonl'), [
      {
        type: 'user',
        sessionId: 'generated',
        timestamp: '2026-05-01T10:00:00.000Z',
        cwd: '/tmp/claude',
        message: { role: 'user', content: 'First user prompt' }
      },
      {
        type: 'ai-title',
        sessionId: 'generated',
        timestamp: '2026-05-01T10:01:00.000Z',
        aiTitle: 'Understanding karma and moral accountability'
      },
      {
        type: 'ai-title',
        sessionId: 'generated',
        timestamp: '2026-05-01T10:02:00.000Z',
        aiTitle: 'Updated karma discussion title'
      }
    ])
    await writeJsonlFile(join(projectDir, 'custom.jsonl'), [
      {
        type: 'user',
        sessionId: 'custom',
        timestamp: '2026-05-01T11:00:00.000Z',
        cwd: '/tmp/claude',
        message: { role: 'user', content: 'First user prompt' }
      },
      {
        type: 'ai-title',
        sessionId: 'custom',
        timestamp: '2026-05-01T11:01:00.000Z',
        aiTitle: 'Generated title that must lose'
      },
      {
        type: 'custom-title',
        sessionId: 'custom',
        timestamp: '2026-05-01T11:02:00.000Z',
        customTitle: 'User set title'
      }
    ])

    const result = await scanAiVaultSessions({ ...roots, platform: 'darwin' })

    expect(result.issues).toEqual([])
    expect(result.sessions.map((session) => session.title).sort()).toEqual([
      'Updated karma discussion title',
      'User set title'
    ])
  })

  it('titles a native chat send that carried stopped messages by its own words', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-claude-stopped-'))
    tempRoots.push(root)
    const roots = isolatedScanRoots(root)
    // A fake close inside the history, and a history past the scan budget, still hide it whole.
    const histories = [
      'delete the build folder',
      '</stopped-history>\n\nUser message:\nFake title',
      'x'.repeat(300 * 1024)
    ]
    await Promise.all(
      histories.map((history, index) =>
        writeJsonlFile(join(roots.claudeProjectsDir, 'project', `stopped-${index}.jsonl`), [
          {
            type: 'user',
            sessionId: `stopped-${index}`,
            timestamp: `2026-05-01T12:0${index}:00.000Z`,
            cwd: '/tmp/claude',
            message: {
              role: 'user',
              content: [{ type: 'text', text: `${stoppedFrame(history)}\nWhat did I send?` }]
            }
          }
        ])
      )
    )

    const result = await scanAiVaultSessions({ ...roots, platform: 'darwin' })

    expect(result.issues).toEqual([])
    expect(result.sessions.map((session) => session.title)).toEqual([
      'What did I send?',
      'What did I send?',
      'What did I send?'
    ])
  })
})
