import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createCodexSessionResumeState,
  parseCodexSessionFile
} from './session-scanner-codex-parser'
import { withFullFirstUserPromptCapture } from './session-scanner-first-user-prompt-capture'
import type { TranscriptMessage } from './session-transcript-consumers'
import {
  stoppedHistoryElement,
  stoppedHistoryFrame
} from '../native-chat/agent-session-wire/structured-agent-session-stopped-history-frame'

let tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

function jsonLines(records: unknown[]): string {
  return records.map((record) => JSON.stringify(record)).join('\n')
}

describe('parseCodexSessionFile', () => {
  it('publishes a paginated agent reply whose block is typed Text to transcript consumers', () => {
    const timestamp = '2026-08-10T10:00:00.000Z'
    const messages: TranscriptMessage[] = []
    const state = createCodexSessionResumeState(
      { path: '/fixture/rollout.jsonl', mtimeMs: Date.parse(timestamp), modifiedAt: timestamp },
      null,
      { active: true, push: (message) => messages.push(message) }
    )
    const consume = (type: string, payload: Record<string, unknown>) =>
      state.consumeLineBytes!(Buffer.from(JSON.stringify({ timestamp, type, payload })))
    consume('session_meta', { id: 'paginated-session', history_mode: 'paginated' })
    consume('event_msg', {
      type: 'item_completed',
      item: { type: 'AgentMessage', content: [{ type: 'Text', text: 'the reply' }] }
    })
    expect(messages).toEqual([{ role: 'assistant', text: 'the reply', timestamp }])
  })

  it('uses completed user items for paginated session metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-codex-paginated-'))
    tempRoots.push(root)
    const sessionPath = join(root, 'sessions', '2026', '08', '10', 'rollout-paginated.jsonl')
    await mkdir(dirname(sessionPath), { recursive: true })

    await writeFile(
      sessionPath,
      jsonLines([
        {
          timestamp: '2026-08-10T10:00:00.000Z',
          type: 'session_meta',
          payload: { id: 'paginated-session', history_mode: 'paginated', cwd: '/repo/app' }
        },
        {
          timestamp: '2026-08-10T10:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'model-only prompt copy' }]
          }
        },
        {
          timestamp: '2026-08-10T10:00:02.000Z',
          type: 'event_msg',
          payload: {
            type: 'item_completed',
            item: {
              type: 'UserMessage',
              content: [{ type: 'text', text: 'Visible paginated prompt' }]
            }
          }
        },
        {
          timestamp: '2026-08-10T10:00:03.000Z',
          type: 'event_msg',
          payload: {
            type: 'item_completed',
            item: {
              type: 'AgentMessage',
              content: [{ type: 'Text', text: 'Visible paginated response' }]
            }
          }
        }
      ])
    )

    const sessionStat = await stat(sessionPath)
    const session = await parseCodexSessionFile(
      {
        path: sessionPath,
        mtimeMs: sessionStat.mtimeMs,
        modifiedAt: sessionStat.mtime.toISOString()
      },
      'darwin',
      root
    )

    expect(session).toMatchObject({
      title: 'Visible paginated prompt',
      lastUserPrompt: 'Visible paginated prompt',
      messageCount: 2,
      previewMessages: [
        { role: 'user', text: 'Visible paginated prompt' },
        { role: 'assistant', text: 'Visible paginated response' }
      ]
    })
  })

  // A fork of a legacy-history thread copies the parent's session_meta in after its own.
  it("keeps a fork's own session_meta when its parent's follows it", async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-codex-fork-'))
    tempRoots.push(root)
    const sessionPath = join(root, 'sessions', '2026', '10', '07', 'rollout-fork.jsonl')
    await mkdir(dirname(sessionPath), { recursive: true })

    await writeFile(
      sessionPath,
      jsonLines([
        {
          timestamp: '2026-10-07T10:00:00.000Z',
          type: 'session_meta',
          payload: {
            id: 'fork-session',
            forked_from_id: 'parent-session',
            cwd: '/repo/fork',
            git: { branch: 'fork-branch' }
          }
        },
        {
          timestamp: '2026-10-07T09:00:00.000Z',
          type: 'session_meta',
          payload: {
            id: 'parent-session',
            title: 'Parent chat',
            history_mode: 'paginated',
            cwd: '/repo/parent',
            git: { branch: 'parent-branch' }
          }
        },
        {
          timestamp: '2026-10-07T09:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Copied prompt' }]
          }
        },
        {
          timestamp: '2026-10-07T09:00:02.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Copied reply' }]
          }
        }
      ])
    )

    const sessionStat = await stat(sessionPath)
    const session = await parseCodexSessionFile(
      {
        path: sessionPath,
        mtimeMs: sessionStat.mtimeMs,
        modifiedAt: sessionStat.mtime.toISOString()
      },
      'darwin',
      root
    )

    expect(session).toMatchObject({
      sessionId: 'fork-session',
      cwd: '/repo/fork',
      branch: 'fork-branch',
      title: 'Copied prompt',
      messageCount: 2
    })
  })

  it('uses user-message events instead of later injected user-role records', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-codex-last-prompt-'))
    tempRoots.push(root)
    const sessionPath = join(root, 'sessions', '2026', '07', '21', 'rollout-last-prompt.jsonl')
    await mkdir(dirname(sessionPath), { recursive: true })

    await writeFile(
      sessionPath,
      jsonLines([
        {
          timestamp: '2026-07-21T10:00:00.000Z',
          type: 'session_meta',
          payload: { id: 'last-prompt-session', cwd: '/repo/app' }
        },
        {
          timestamp: '2026-07-21T10:00:01.000Z',
          type: 'event_msg',
          payload: { type: 'user_message', message: 'Review the PR and fix real regressions' }
        },
        {
          timestamp: '2026-07-21T10:00:02.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: '<skill>performance instructions</skill>' }]
          }
        }
      ])
    )

    const sessionStat = await stat(sessionPath)
    const session = await parseCodexSessionFile(
      {
        path: sessionPath,
        mtimeMs: sessionStat.mtimeMs,
        modifiedAt: sessionStat.mtime.toISOString()
      },
      'darwin',
      root
    )

    expect(session?.lastUserPrompt).toBe('Review the PR and fix real regressions')
  })

  it('titles a native chat send that carried stopped messages by its own words', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-codex-stopped-'))
    tempRoots.push(root)
    const sessionPath = join(root, 'sessions', '2026', '07', '21', 'rollout-stopped.jsonl')
    await mkdir(dirname(sessionPath), { recursive: true })
    const stopped = stoppedHistoryFrame({
      elements: [
        stoppedHistoryElement({
          number: 1,
          text: 'delete the build folder',
          images: { first: 1, count: 1 },
          omittedImages: 0
        })
      ],
      notIncluded: 0,
      shortened: 0,
      sendImages: { first: 2, count: 0 }
    })
    await writeFile(
      sessionPath,
      jsonLines([
        {
          timestamp: '2026-07-21T10:00:00.000Z',
          type: 'session_meta',
          payload: { id: 'stopped-session', cwd: '/repo/app' }
        },
        {
          timestamp: '2026-07-21T10:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [
              { type: 'input_text', text: stopped },
              { type: 'input_text', text: 'What did I send?' }
            ]
          }
        },
        {
          timestamp: '2026-07-21T10:00:02.000Z',
          type: 'event_msg',
          // Codex's own record of the send joins its text items.
          payload: { type: 'user_message', message: `${stopped}What did I send?` }
        }
      ])
    )

    const sessionStat = await stat(sessionPath)
    const session = await parseCodexSessionFile(
      {
        path: sessionPath,
        mtimeMs: sessionStat.mtimeMs,
        modifiedAt: sessionStat.mtime.toISOString()
      },
      'darwin',
      root
    )

    expect(session?.title).toBe('What did I send?')
    expect(session?.lastUserPrompt).toBe('What did I send?')
  })

  it('titles a send whose carried history images Codex labeled before the frame by its own words', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-codex-stopped-images-'))
    tempRoots.push(root)
    const sessionPath = join(root, 'sessions', '2026', '07', '21', 'rollout-stopped-images.jsonl')
    await mkdir(dirname(sessionPath), { recursive: true })
    const stopped = stoppedHistoryFrame({
      elements: [
        stoppedHistoryElement({
          number: 1,
          text: 'compare these screenshots',
          images: { first: 1, count: 2 },
          omittedImages: 0
        })
      ],
      notIncluded: 0,
      shortened: 0,
      sendImages: { first: 3, count: 1 }
    })
    const attachments = `/Users/example/Library/Application Support/Orca/attachments/${'session-0123456789abcdef/'.repeat(4)}`
    // How Codex records each localImage input: a labeled opener with the path, the image, a closer.
    const localImage = (number: number, name: string) => [
      {
        type: 'input_text',
        text: `<image name=[Image #${number}] path="${attachments}${name}">`
      },
      { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
      { type: 'input_text', text: '</image>' }
    ]
    await writeFile(
      sessionPath,
      jsonLines([
        {
          timestamp: '2026-07-21T10:00:00.000Z',
          type: 'session_meta',
          payload: { id: 'stopped-images-session', cwd: '/repo/app' }
        },
        {
          timestamp: '2026-07-21T10:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [
              ...localImage(1, 'before.png'),
              ...localImage(2, 'after.png'),
              { type: 'input_text', text: stopped },
              { type: 'input_text', text: 'Which one is right?' },
              ...localImage(3, 'mine.png')
            ]
          }
        }
      ])
    )

    const sessionStat = await stat(sessionPath)
    const session = await withFullFirstUserPromptCapture(() =>
      parseCodexSessionFile(
        {
          path: sessionPath,
          mtimeMs: sessionStat.mtimeMs,
          modifiedAt: sessionStat.mtime.toISOString()
        },
        'darwin',
        root
      )
    )

    // The send's own image keeps its label, as any image send's title and preview do.
    const ownWords = /^Which one is right\? <image name=\[Image #3\]/
    expect(session?.title).toMatch(ownWords)
    expect(session?.previewMessages[0]?.text).toMatch(ownWords)
    expect(session?.firstUserPrompt).toBe(
      `Which one is right?\n<image name=[Image #3] path="${attachments}mine.png">\n</image>`
    )
  })

  it('keeps image labels when no stopped-history frame follows them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-codex-plain-images-'))
    tempRoots.push(root)
    const sessionPath = join(root, 'sessions', '2026', '07', '21', 'rollout-plain-images.jsonl')
    await mkdir(dirname(sessionPath), { recursive: true })
    await writeFile(
      sessionPath,
      jsonLines([
        {
          timestamp: '2026-07-21T10:00:00.000Z',
          type: 'session_meta',
          payload: { id: 'plain-images-session', cwd: '/repo/app' }
        },
        {
          timestamp: '2026-07-21T10:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: '<image name=[Image #1] path="/tmp/shot.png">'
              },
              { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
              { type: 'input_text', text: '</image>' },
              { type: 'input_text', text: 'What is this?' }
            ]
          }
        }
      ])
    )

    const sessionStat = await stat(sessionPath)
    const session = await parseCodexSessionFile(
      {
        path: sessionPath,
        mtimeMs: sessionStat.mtimeMs,
        modifiedAt: sessionStat.mtime.toISOString()
      },
      'darwin',
      root
    )

    expect(session?.title).toBe(
      '<image name=[Image #1] path="/tmp/shot.png"> </image> What is this?'
    )
  })

  it('does not double-count usage when token count formats switch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-codex-token-switch-'))
    tempRoots.push(root)
    const sessionPath = join(root, 'sessions', '2026', '06', '18', 'rollout-token-switch.jsonl')
    await mkdir(dirname(sessionPath), { recursive: true })

    await writeFile(
      sessionPath,
      jsonLines([
        {
          timestamp: '2026-06-18T10:00:00.000Z',
          type: 'session_meta',
          payload: { id: 'token-format-switch', cwd: '/repo/app' }
        },
        {
          timestamp: '2026-06-18T10:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'text', text: 'Measure Codex token totals' }]
          }
        },
        {
          timestamp: '2026-06-18T10:00:02.000Z',
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              last_token_usage: {
                input_tokens: 70,
                cached_input_tokens: 20,
                output_tokens: 30,
                total_tokens: 100
              }
            }
          }
        },
        {
          timestamp: '2026-06-18T10:00:03.000Z',
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: {
                input_tokens: 90,
                cached_input_tokens: 25,
                output_tokens: 60,
                total_tokens: 150
              }
            }
          }
        }
      ])
    )

    const sessionStat = await stat(sessionPath)
    const session = await parseCodexSessionFile(
      {
        path: sessionPath,
        mtimeMs: sessionStat.mtimeMs,
        modifiedAt: sessionStat.mtime.toISOString()
      },
      'darwin',
      root
    )

    expect(session?.totalTokens).toBe(150)
  })

  it('extracts the model from turn context, latest turn winning', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-codex-model-'))
    tempRoots.push(root)
    const sessionPath = join(root, 'sessions', '2026', '07', '05', 'rollout-model.jsonl')
    await mkdir(dirname(sessionPath), { recursive: true })

    await writeFile(
      sessionPath,
      jsonLines([
        {
          timestamp: '2026-07-05T10:00:00.000Z',
          type: 'session_meta',
          payload: { id: 'model-session', cwd: '/repo/app' }
        },
        {
          timestamp: '2026-07-05T10:00:01.000Z',
          type: 'turn_context',
          payload: { cwd: '/repo/app', model: 'gpt-5.1' }
        },
        {
          timestamp: '2026-07-05T10:00:02.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'text', text: 'Switch the model' }]
          }
        },
        {
          // A /model switch mid-session writes a later turn_context.
          timestamp: '2026-07-05T10:00:03.000Z',
          type: 'turn_context',
          payload: { cwd: '/repo/app', model: 'gpt-5.5' }
        }
      ])
    )

    const sessionStat = await stat(sessionPath)
    const session = await parseCodexSessionFile(
      {
        path: sessionPath,
        mtimeMs: sessionStat.mtimeMs,
        modifiedAt: sessionStat.mtime.toISOString()
      },
      'darwin',
      root
    )

    expect(session?.model).toBe('gpt-5.5')
  })
})
