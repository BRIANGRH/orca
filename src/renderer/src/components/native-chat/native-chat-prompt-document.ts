import { NativeChatFileReferencePill } from './NativeChatFileReferencePill'
import { NativeChatSkillPill } from './NativeChatSkillPill'
import { formatNativeChatFileReference } from '../../../../shared/agent-image-paste'
import { ReactNodeViewRenderer, Node, type JSONContent } from '@tiptap/react'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
export { promptTextContent } from './native-chat-prompt-document-text'

export const NativeChatSkill = Node.create({
  name: 'nativeChatSkill',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addNodeView: () => ReactNodeViewRenderer(NativeChatSkillPill),
  addAttributes: () => ({ token: { default: '' } }),
  renderText: ({ node }) => node.attrs.token,
  renderHTML: ({ node }) => [
    'span',
    {
      'data-native-chat-skill': node.attrs.token,
      contenteditable: 'false',
      class:
        'inline-flex items-center gap-1 rounded-full border border-border bg-muted px-1.5 text-xs font-medium text-muted-foreground align-baseline select-none'
    },
    ['span', { 'aria-hidden': 'true' }, 'ϟ'],
    ['span', {}, String(node.attrs.token).slice(1)]
  ]
})

/** A file attached by path. `token` is the reference the agent reads; the pill shows the filename. */
export const NativeChatFileReference = Node.create({
  name: 'nativeChatFileReference',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addNodeView: () => ReactNodeViewRenderer(NativeChatFileReferencePill),
  addAttributes: () => ({ token: { default: '' }, path: { default: '' } }),
  renderText: ({ node }) => node.attrs.token,
  renderHTML: ({ node }) => ['span', { 'data-native-chat-file-reference': node.attrs.path }]
})

export function fileReferenceContent(path: string): JSONContent {
  return {
    type: NativeChatFileReference.name,
    attrs: { token: formatNativeChatFileReference(path), path }
  }
}

export type PromptTextMap = { readonly text: string; readonly positions: readonly number[] }

// Why: documents are immutable and caret reads repeat on an unchanged draft; weak keys die with the doc.
const promptTextMaps = new WeakMap<ProseMirrorNode, PromptTextMap>()

/** Each boundary maps a plain-text caret to a document position, including atomic skills. */
export function promptTextMap(doc: ProseMirrorNode): PromptTextMap {
  const cached = promptTextMaps.get(doc)
  if (cached) {
    return cached
  }
  const parts: string[] = []
  const positions = [1]
  doc.forEach((block, blockOffset, index) => {
    if (index > 0) {
      parts.push('\n')
      positions.push(blockOffset + 1)
    }
    block.forEach((node, offset) => {
      const start = blockOffset + 1 + offset
      const value = node.isText
        ? node.text!
        : node.type.name === 'hardBreak'
          ? '\n'
          : String(node.attrs.token ?? '')
      parts.push(value)
      for (let i = 0; i < value.length; i++) {
        positions.push(
          node.isText ? start + i + 1 : i === value.length - 1 ? start + node.nodeSize : start
        )
      }
    })
  })
  const map = { text: parts.join(''), positions }
  promptTextMaps.set(doc, map)
  return map
}

export function promptTextOffset(doc: ProseMirrorNode, position: number): number {
  const { positions } = promptTextMap(doc)
  // Positions never decrease, so the first one at or past `position` is a lower bound.
  let low = 0
  let high = positions.length
  while (low < high) {
    const mid = (low + high) >>> 1
    if (positions[mid] < position) {
      low = mid + 1
    } else {
      high = mid
    }
  }
  return low === positions.length ? positions.length - 1 : low
}
