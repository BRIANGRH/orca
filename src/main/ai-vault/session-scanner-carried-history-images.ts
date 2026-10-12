import { withoutStoppedHistoryFrame } from '../native-chat/agent-session-wire/structured-agent-session-stopped-history-frame'

// Codex records each local image as an `<image name=[Image #N] path="...">` text item, the image,
// then a `</image>` text item, so a send's carried history images sit before its frame as text.
const LOCAL_IMAGE_OPEN_PREFIX = '<image name='
const LOCAL_IMAGE_CLOSE = '</image>'

/** `content` without the image-label items ahead of a leading stopped-history frame, so titles,
 *  previews and the copied prompt start at the frame; unchanged unless a real frame follows. */
export function withoutCarriedHistoryImageLabels(content: readonly unknown[]): readonly unknown[] {
  let index = 0
  while (isLocalImageGroup(content, index)) {
    index += 3
  }
  if (index === 0) {
    return content
  }
  const frame = itemText(content[index])
  return frame !== null && withoutStoppedHistoryFrame(frame) !== frame
    ? content.slice(index)
    : content
}

function isLocalImageGroup(content: readonly unknown[], index: number): boolean {
  const open = itemText(content[index])
  return (
    open !== null &&
    open.startsWith(LOCAL_IMAGE_OPEN_PREFIX) &&
    open.endsWith('>') &&
    itemType(content[index + 1]) === 'input_image' &&
    itemText(content[index + 2]) === LOCAL_IMAGE_CLOSE
  )
}

function itemType(item: unknown): unknown {
  return item && typeof item === 'object' && 'type' in item ? item.type : undefined
}

function itemText(item: unknown): string | null {
  return item && typeof item === 'object' && 'text' in item && typeof item.text === 'string'
    ? item.text
    : null
}
