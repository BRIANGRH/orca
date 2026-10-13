import { describe, expect, it } from 'vitest'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import type { OwedStoppedMessage } from '../../../shared/agent-session-stopped-history'
import {
  fitStoppedHistory,
  withStoppedHistoryText,
  type StoppedHistoryFitInput
} from './structured-agent-session-stopped-history-fit'

function owed(id: string, blocks: AgentJournalMessageItem['blocks']): OwedStoppedMessage {
  return {
    body: { kind: 'message', role: 'user', blocks },
    submission: {
      clientMessageId: id,
      fence: 1,
      payloadFingerprint: id,
      submittedAt: 1,
      resolvedAt: 1,
      providerItemId: null,
      handoverRecorded: true,
      acceptedSequence: 1,
      origin: 'client',
      source: { kind: 'user' },
      dispatchState: 'rejected',
      ...agentSessionFailureWords(
        agentSessionFailureFact('cancelled', { neverReachedAgent: true }),
        { surface: 'rejection' }
      )
    }
  }
}

const text = (id: string, words: string) => owed(id, [{ type: 'text', text: words }])

function fit(
  messages: OwedStoppedMessage[],
  room: StoppedHistoryFitInput<string>['room'] = {},
  image: StoppedHistoryFitInput<string>['image'] = async (block) => ({
    content: block.path ?? '',
    cost: { images: 1 }
  })
) {
  return fitStoppedHistory({
    owed: messages,
    room,
    textCost: (words) => ({ chars: words.length }),
    image
  })
}

describe('stopped messages an ACP or Pi send carries', () => {
  it('carries each as its words and the interruption, oldest first, ahead of the send', async () => {
    const carried = await fit([text('a', 'delete the build'), text('b', 'then rebuild')])

    expect(carried?.carries).toEqual(['a', 'b'])
    expect(withStoppedHistoryText(carried!.text, 'what did I send?')).toBe(
      'delete the build\n\n[Request interrupted by user]\n\n' +
        'then rebuild\n\n[Request interrupted by user]\n\n' +
        'what did I send?'
    )
  })

  it('ends at the last interruption when the send has no words of its own', async () => {
    const carried = await fit([text('a', 'delete the build')])

    expect(withStoppedHistoryText(carried!.text, '')).toBe(
      'delete the build\n\n[Request interrupted by user]'
    )
  })

  it('joins a message’s text blocks and keeps its images, in order, ahead of the send’s', async () => {
    const carried = await fit([
      owed('a', [
        { type: 'image-ref', path: 'one.png' },
        { type: 'text', text: 'first' },
        { type: 'text', text: 'second' },
        { type: 'image-ref', path: 'two.png' }
      ]),
      owed('b', [{ type: 'image-ref', path: 'three.png' }])
    ])

    expect(carried).toEqual({
      carries: ['a', 'b'],
      images: ['one.png', 'two.png', 'three.png'],
      text: 'first\nsecond\n\n[Request interrupted by user]\n\n[Request interrupted by user]\n\n'
    })
  })

  it('carries only whole messages: the first that does not fit waits, and every later one with it', async () => {
    const carried = await fit([text('a', 'short'), text('b', 'x'.repeat(100)), text('c', 'tiny')], {
      chars: 80
    })

    expect(carried?.carries).toEqual(['a'])
    expect(carried?.text).not.toContain('tiny')
  })

  it('counts a message’s images against the room, and waits when they do not fit', async () => {
    const twoImages = owed('a', [
      { type: 'image-ref', path: 'one.png' },
      { type: 'image-ref', path: 'two.png' }
    ])

    expect(await fit([twoImages], { images: 1 })).toBeNull()
    expect((await fit([twoImages], { images: 2 }))?.images).toEqual(['one.png', 'two.png'])
  })

  it('leaves out an image the agent refuses, and carries the rest of the message', async () => {
    const carried = await fit(
      [
        owed('a', [
          { type: 'image-ref', path: 'gone.png' },
          { type: 'text', text: 'look' }
        ])
      ],
      {},
      async (block) => {
        if (block.path === 'gone.png') {
          throw new Error('unreadable')
        }
        return { content: block.path ?? '', cost: {} }
      }
    )

    expect(carried).toEqual({
      carries: ['a'],
      images: [],
      text: 'look\n\n[Request interrupted by user]\n\n'
    })
  })

  it('carries none when the oldest does not fit', async () => {
    expect(await fit([text('a', 'x'.repeat(100)), text('b', 'y')], { chars: 50 })).toBeNull()
  })
})

describe('a stopped image whose read stalls', () => {
  it('is left out in time, and its message still rides whole with its words', async () => {
    const started = Date.now()
    const carried = await fit(
      [
        owed('a', [
          { type: 'image-ref', path: '/hung/fit.png' },
          { type: 'text', text: 'look' }
        ])
      ],
      {},
      () => new Promise(() => {})
    )
    expect(Date.now() - started).toBeLessThan(1_900)
    expect(carried?.carries).toEqual(['a'])
    expect(carried?.images).toEqual([])
    expect(carried?.text).toBe('look\n\n[Request interrupted by user]\n\n')
  })

  it('is not read once the preparation gave up', async () => {
    const giveUp = new AbortController()
    giveUp.abort()
    let reads = 0
    const carried = await fitStoppedHistory({
      owed: [
        owed('a', [
          { type: 'image-ref', path: 'one.png' },
          { type: 'text', text: 'look' }
        ])
      ],
      room: {},
      textCost: () => ({}),
      image: async () => {
        reads += 1
        return { content: 'one', cost: {} }
      },
      signal: giveUp.signal
    })
    expect(reads).toBe(0)
    expect(carried?.images).toEqual([])
  })
})
