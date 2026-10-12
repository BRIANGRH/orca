// Which owed stopped messages an ACP or Pi send carries, which cannot append them to the agent's own
// log: each whole, oldest first, as its words and then the record Claude writes for its own Stop,
// ahead of the send's own words, with its images ahead of the send's. Only the agent's own admission
// limits bound them; the first that does not fit waits, with every later one, for a send with room.

import {
  STOPPED_MESSAGE_INTERRUPTED_MARKER,
  type OwedStoppedMessage
} from '../../../shared/agent-session-stopped-history'
import type { NativeChatImageRefBlock } from '../../../shared/native-chat-types'

/** An amount per admission limit, keyed by the adapter's own names; a missing key costs nothing. */
export type StoppedHistoryCost = Readonly<Record<string, number>>

export type StoppedHistoryFitInput<TImage> = {
  owed: readonly OwedStoppedMessage[]
  /** What the agent still admits beside the send, per limit; an unnamed limit is unbounded. */
  room: StoppedHistoryCost
  /** What text costs; additive, so the carried words cost the sum of each message's. */
  textCost: (text: string) => StoppedHistoryCost
  /** One stopped image as the agent's content; null or a throw leaves that image out. */
  image: (
    block: NativeChatImageRefBlock
  ) => Promise<{ content: TImage; cost: StoppedHistoryCost } | null>
}

export type StoppedHistoryFit<TImage> = {
  /** The stopped messages carried, oldest first. */
  carries: string[]
  /** Their images, which go ahead of the send's own. */
  images: TImage[]
  /** Their words, ending in the break the send's own words follow. */
  text: string
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

function minus(room: StoppedHistoryCost, cost: StoppedHistoryCost): StoppedHistoryCost {
  return Object.fromEntries(
    Object.entries(room).map(([key, value]) => [key, value - (cost[key] ?? 0)])
  )
}

/** One stopped message as the agent reads it, ending in the break before what follows. */
function carriedText(entry: OwedStoppedMessage): string {
  const words = entry.body.blocks
    .flatMap((block) => (block.type === 'text' && block.text.length > 0 ? [block.text] : []))
    .join('\n')
  return `${words.length > 0 ? `${words}\n\n` : ''}${STOPPED_MESSAGE_INTERRUPTED_MARKER}\n\n`
}

/** The carried words joined to the send's own; with none of its own, without the trailing break. */
export function withStoppedHistoryText(carried: string, own: string): string {
  return own.length > 0 ? `${carried}${own}` : carried.trimEnd()
}

/** Oldest first, each owed message whole while it fits, less any image the agent refuses. Null
 *  when none fits. */
export async function fitStoppedHistory<TImage>(
  input: StoppedHistoryFitInput<TImage>
): Promise<StoppedHistoryFit<TImage> | null> {
  let room = input.room
  const fit: StoppedHistoryFit<TImage> = { carries: [], images: [], text: '' }
  for (const entry of input.owed) {
    const text = carriedText(entry)
    let cost = input.textCost(text)
    if (!fits(cost, room)) {
      break
    }
    const images: TImage[] = []
    for (const block of entry.body.blocks) {
      const read = block.type === 'image-ref' ? await input.image(block).catch(() => null) : null
      if (read) {
        images.push(read.content)
        cost = plus(cost, read.cost)
      }
    }
    if (!fits(cost, room)) {
      break
    }
    room = minus(room, cost)
    fit.carries.push(entry.submission.clientMessageId)
    fit.images.push(...images)
    fit.text += text
  }
  return fit.carries.length > 0 ? fit : null
}
