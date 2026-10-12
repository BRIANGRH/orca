// Which owed stopped messages fit beside a send within one agent's admission limits, and the frame
// that carries them. Each message's cost is measured once and its images read once; the adapter
// supplies the limits, the cost of text and its own image content, and writes what this returns.

import type { OwedStoppedMessage } from '../../../shared/agent-session-stopped-history'
import type { NativeChatImageRefBlock } from '../../../shared/native-chat-types'
import { sliceAtCodeUnitLimit } from '../../../shared/surrogate-safe-text-slice'
import {
  stoppedHistoryElement,
  stoppedHistoryElementSpan,
  stoppedHistoryFrame,
  type StoppedHistoryElement
} from './structured-agent-session-stopped-history-frame'

// Carried history stays a small part of any model's context.
export const STOPPED_HISTORY_MAX_CHARS = 64_000

/** An amount per admission limit, keyed by the adapter's own names; a missing key costs nothing. */
export type StoppedHistoryCost = Readonly<Record<string, number>>

export type StoppedHistoryFitInput<TImage> = {
  owed: readonly OwedStoppedMessage[]
  /** What the agent still admits beside the send, per limit; an unnamed limit is unbounded. */
  room: StoppedHistoryCost
  /** How many images the send itself carries, numbered after the history's. */
  sendImages: number
  /** What text costs; additive, so a frame costs the sum of its parts. */
  textCost: (text: string) => StoppedHistoryCost
  /** One stopped image as the agent's content; null or a throw leaves the message's images out. */
  image: (
    block: NativeChatImageRefBlock
  ) => Promise<{ content: TImage; cost: StoppedHistoryCost } | null>
}

export type StoppedHistoryFit<TImage> = {
  /** The stopped messages inside `frame`, oldest first. */
  carries: string[]
  /** Their images in the frame's numbering, which go ahead of the send's own. */
  images: TImage[]
  /** The frame, ending with the label the send's own words follow. */
  frame: string
}

function plus(left: StoppedHistoryCost, right: StoppedHistoryCost): StoppedHistoryCost {
  const sum: Record<string, number> = { ...left }
  for (const [key, value] of Object.entries(right)) {
    sum[key] = (sum[key] ?? 0) + value
  }
  return sum
}

function fits(cost: StoppedHistoryCost, room: StoppedHistoryCost): boolean {
  return Object.entries(cost).every(([key, value]) => value <= (room[key] ?? Infinity))
}

/** What is left of `room` after `cost`; an unbounded limit stays unbounded. */
function minus(room: StoppedHistoryCost, cost: StoppedHistoryCost): StoppedHistoryCost {
  return Object.fromEntries(
    Object.entries(room).map(([key, value]) => [key, value - (cost[key] ?? 0)])
  )
}

function wordsOf(entry: OwedStoppedMessage): string {
  return entry.body.blocks
    .flatMap((block) => (block.type === 'text' && block.text.length > 0 ? [block.text] : []))
    .join('\n')
}

function imagesOf(entry: OwedStoppedMessage): NativeChatImageRefBlock[] {
  return entry.body.blocks.filter(
    (block): block is NativeChatImageRefBlock => block.type === 'image-ref'
  )
}

async function readImages<TImage>(
  blocks: readonly NativeChatImageRefBlock[],
  image: StoppedHistoryFitInput<TImage>['image']
): Promise<{ content: TImage; cost: StoppedHistoryCost }[] | null> {
  const read: { content: TImage; cost: StoppedHistoryCost }[] = []
  for (const block of blocks) {
    const prepared = await image(block).catch(() => null)
    if (!prepared) {
      return null
    }
    read.push(prepared)
  }
  return read
}

/** The longest start of `element.text` whose element fits `room`, keeping at least one character. */
function shortenedToFit(
  element: StoppedHistoryElement,
  room: StoppedHistoryCost,
  textCost: StoppedHistoryFitInput<unknown>['textCost']
): string | null {
  const total = element.text.length
  const render = (kept: number): string => {
    const text = sliceAtCodeUnitLimit(element.text, kept)
    return stoppedHistoryElement({
      ...element,
      text,
      shortened: { leftOut: total - text.length, total }
    })
  }
  const fitsKeeping = (kept: number): boolean =>
    fits(textCost(stoppedHistoryElementSpan(render(kept))), room)
  const first = element.text.codePointAt(0)
  const least = first === undefined ? 0 : String.fromCodePoint(first).length
  if (least === 0 || !fitsKeeping(least)) {
    return null
  }
  let low = least
  let high = total - 1
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (fitsKeeping(middle)) {
      low = middle
    } else {
      high = middle - 1
    }
  }
  return render(low)
}

/** Oldest first, each owed message rides whole while it fits, less any image the agent refuses.
 *  Only the oldest may ride without its images or with its words shortened for want of room, so a
 *  message squeezed out by earlier ones waits whole for a send with room, the frame saying so. Null
 *  when none rides. */
export async function fitStoppedHistory<TImage>(
  input: StoppedHistoryFitInput<TImage>
): Promise<StoppedHistoryFit<TImage> | null> {
  const { owed } = input
  const textCost = (text: string): StoppedHistoryCost =>
    plus(input.textCost(text), { stoppedHistoryChars: text.length })
  const startingRoom = { ...input.room, stoppedHistoryChars: STOPPED_HISTORY_MAX_CHARS }
  const historyImages = owed.reduce((sum, entry) => sum + imagesOf(entry).length, 0)
  // The frame around the elements at its longest: every count and image number at its widest.
  const skeleton = stoppedHistoryFrame({
    elements: [],
    notIncluded: owed.length,
    shortened: owed.length,
    sendImages: { first: historyImages + 1, count: input.sendImages }
  })
  if (!fits(textCost(skeleton), startingRoom)) {
    return null
  }
  let room = minus(startingRoom, textCost(skeleton))
  const carries: string[] = []
  const images: TImage[] = []
  const elements: string[] = []
  let shortened = 0
  for (const entry of owed) {
    const blocks = imagesOf(entry)
    const element: StoppedHistoryElement = {
      number: elements.length + 1,
      text: wordsOf(entry),
      images: { first: images.length + 1, count: 0 },
      omittedImages: blocks.length
    }
    let chosen: { text: string; cost: StoppedHistoryCost; images: TImage[] } | null = null
    let refused = false
    if (blocks.length > 0) {
      const text = stoppedHistoryElement({
        ...element,
        images: { first: images.length + 1, count: blocks.length },
        omittedImages: 0
      })
      const cost = textCost(stoppedHistoryElementSpan(text))
      const read = fits(cost, room) ? await readImages(blocks, input.image) : undefined
      refused = read === null
      const whole = read ? read.reduce((sum, item) => plus(sum, item.cost), cost) : null
      if (read && whole && fits(whole, room)) {
        chosen = { text, cost: whole, images: read.map((item) => item.content) }
      }
    }
    // An image the agent refuses never rides, so without it a message is whole; leaving out images
    // only for want of room is the oldest's alone.
    if (!chosen && (blocks.length === 0 || refused || elements.length === 0)) {
      const text = stoppedHistoryElement(element)
      const cost = textCost(stoppedHistoryElementSpan(text))
      if (fits(cost, room)) {
        chosen = { text, cost, images: [] }
      }
    }
    if (!chosen && elements.length > 0) {
      break
    }
    if (!chosen) {
      const text = shortenedToFit(element, room, textCost)
      if (text === null) {
        break
      }
      shortened += 1
      chosen = { text, cost: textCost(stoppedHistoryElementSpan(text)), images: [] }
    }
    room = minus(room, chosen.cost)
    carries.push(entry.submission.clientMessageId)
    images.push(...chosen.images)
    elements.push(chosen.text)
  }
  if (carries.length === 0) {
    return null
  }
  return {
    carries,
    images,
    frame: stoppedHistoryFrame({
      elements,
      notIncluded: owed.length - carries.length,
      shortened,
      sendImages: { first: images.length + 1, count: input.sendImages }
    })
  }
}
