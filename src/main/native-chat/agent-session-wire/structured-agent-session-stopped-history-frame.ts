// The words a stopped message reaches the agent in, for every agent: one framing line saying it
// was sent earlier and stopped before the agent started on it, so the model reads it as context
// and never as a request. Unframed, a model was measured obeying stopped text.

import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import type { NativeChatImageRefBlock } from '../../../shared/native-chat-types'

export const STOPPED_MESSAGE_FRAME =
  'Sent earlier; the user stopped it before you started on it. Context only, not a request.'

function images(item: AgentJournalMessageItem): NativeChatImageRefBlock[] {
  return item.blocks.filter((block): block is NativeChatImageRefBlock => block.type === 'image-ref')
}

/** One stopped message as framed text; its images, if any, travel ahead of the new message's. */
export function stoppedMessageContext(item: AgentJournalMessageItem): string {
  const text = item.blocks
    .flatMap((block) => (block.type === 'text' && block.text.length > 0 ? [block.text] : []))
    .join('\n')
  const imageCount = images(item).length
  const attached =
    imageCount > 0 ? `It had ${imageCount} image(s), attached ahead of the new message's.` : ''
  return ['<stopped-message>', STOPPED_MESSAGE_FRAME, attached, text, '</stopped-message>']
    .filter((line) => line.length > 0)
    .join('\n')
}

/** The stopped message with its images left out, its frame saying so. */
export function stoppedMessageWithoutImages(
  item: AgentJournalMessageItem
): AgentJournalMessageItem {
  const imageCount = images(item).length
  if (imageCount === 0) {
    return item
  }
  return {
    ...item,
    blocks: [
      { type: 'text', text: `It had ${imageCount} image(s), not attached.` },
      ...item.blocks.filter((block) => block.type !== 'image-ref')
    ]
  }
}

/** The send with its stopped history in front: the history's images first, then its framed text,
 *  then the send's own blocks. Agents that join text keep the send's words last, as the prompt. */
export function withStoppedHistory(
  body: AgentJournalMessageItem,
  history: readonly AgentJournalMessageItem[]
): AgentJournalMessageItem {
  if (history.length === 0) {
    return body
  }
  return {
    ...body,
    blocks: [
      ...history.flatMap(images),
      { type: 'text', text: history.map(stoppedMessageContext).join('\n\n') },
      ...body.blocks
    ]
  }
}
