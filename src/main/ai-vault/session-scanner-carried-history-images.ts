import { STOPPED_HISTORY_MAX_IMAGES } from '../native-chat/agent-session-wire/structured-agent-session-stopped-history-fit'
import { withoutStoppedHistoryFrame } from '../native-chat/agent-session-wire/structured-agent-session-stopped-history-frame'

// An agent writes at most three items per carried image ahead of the frame (Codex: label, image,
// close), so a frame is never later than this; looking no further keeps a scan bounded.
export const CARRIED_HISTORY_MAX_LEADING_ITEMS = 3 * STOPPED_HISTORY_MAX_IMAGES

/** `content` from its stopped-history frame on, so titles, previews and the copied prompt never show
 *  what an agent wrote for the carried history's images ahead of it (Codex labels each with its path,
 *  or says it could not read it). Only those images go before the frame; unchanged without one. */
export function withoutCarriedHistoryImages(content: readonly unknown[]): readonly unknown[] {
  const lookahead = Math.min(content.length, CARRIED_HISTORY_MAX_LEADING_ITEMS + 1)
  for (let index = 1; index < lookahead; index += 1) {
    const text = itemText(content[index])
    if (text !== null && withoutStoppedHistoryFrame(text) !== text) {
      return content.slice(index)
    }
  }
  return content
}

function itemText(item: unknown): string | null {
  return item && typeof item === 'object' && 'text' in item && typeof item.text === 'string'
    ? item.text
    : null
}
