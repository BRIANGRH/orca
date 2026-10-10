// Stopped messages on a Codex `turn/start`, in the same request as the new message. A text-only one
// rides `additionalContext` as untrusted context, which Codex records with the turn and keeps out
// of the user message; one with images, which that field cannot carry, rides as leading framed
// input items, as every stopped message does on a `turn/steer`, which has no such field here.

import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import { stoppedMessageContext } from '../native-chat/agent-session-wire/structured-agent-session-stopped-history-frame'

type CodexContextEntry = { kind: 'untrusted'; value: string }

function hasImages(item: AgentJournalMessageItem): boolean {
  return item.blocks.some((block) => block.type === 'image-ref')
}

/** Codex orders entries by key and records one only when its value under that key changed, so
 *  each key names the send it rides on, then the message's place in send order. */
function contextKey(carrierId: string, index: number): string {
  return `orca_stopped_${carrierId.replace(/[^A-Za-z0-9_-]/g, '_')}_${String(index).padStart(3, '0')}`
}

/** `turn/start.additionalContext` for the text-only stopped messages; undefined when none. */
export function codexStoppedHistoryContext(
  carrierId: string,
  history: readonly AgentJournalMessageItem[]
): Record<string, CodexContextEntry> | undefined {
  const entries = history.flatMap((item, index): [string, CodexContextEntry][] =>
    hasImages(item)
      ? []
      : [[contextKey(carrierId, index), { kind: 'untrusted', value: stoppedMessageContext(item) }]]
  )
  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

/** The stopped messages that ride as leading input: those with images, or all of them `inline`. */
export function codexStoppedHistoryInputMessages(
  history: readonly AgentJournalMessageItem[],
  inline: boolean
): AgentJournalMessageItem[] {
  return history
    .filter((item) => inline || hasImages(item))
    .map((item) => ({
      ...item,
      blocks: [
        ...item.blocks.filter((block) => block.type === 'image-ref'),
        { type: 'text', text: stoppedMessageContext(item) }
      ]
    }))
}
