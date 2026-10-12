import { getSchema } from '@tiptap/core'
import { Fragment, Slice } from '@tiptap/pm/model'
import StarterKit from '@tiptap/starter-kit'
import { describe, expect, it } from 'vitest'
import {
  NativeChatFileReference,
  NativeChatSkill,
  promptTextMap,
  promptTextOffset
} from './native-chat-prompt-document'

const schema = getSchema([StarterKit, NativeChatSkill, NativeChatFileReference])

function documentWithAtoms() {
  return schema.nodeFromJSON({
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'a😀' },
          { type: 'nativeChatSkill', attrs: { token: '$rev' } },
          { type: 'hardBreak' },
          { type: 'text', text: 'b' }
        ]
      },
      {
        type: 'paragraph',
        content: [{ type: 'nativeChatFileReference', attrs: { token: '@f', path: '/f' } }]
      },
      { type: 'paragraph' }
    ]
  })
}

describe('promptTextMap', () => {
  it('maps UTF-16 units, atoms, hard breaks and paragraphs to document positions', () => {
    expect(promptTextMap(documentWithAtoms())).toEqual({
      text: 'a😀$rev\nb\n@f\n',
      positions: [1, 2, 3, 4, 4, 4, 4, 5, 6, 7, 9, 9, 10, 12]
    })
  })

  it('reuses the map for the same document and builds an equal one for a fresh copy', () => {
    const doc = documentWithAtoms()
    const first = promptTextMap(doc)
    expect(promptTextMap(doc)).toBe(first)
    const copy = schema.nodeFromJSON(doc.toJSON())
    expect(promptTextMap(copy)).not.toBe(first)
    expect(promptTextMap(copy)).toEqual(first)
  })

  it('maps an edited document from its own content', () => {
    const doc = documentWithAtoms()
    const before = promptTextMap(doc)
    const edited = doc.replace(1, 2, new Slice(Fragment.from(schema.text('xyz')), 0, 0))
    expect(promptTextMap(edited).text).toBe('xyz😀$rev\nb\n@f\n')
    expect(promptTextMap(doc)).toBe(before)
  })

  it('finds the same caret offset as a linear scan for every document position', () => {
    const doc = documentWithAtoms()
    const { positions } = promptTextMap(doc)
    for (let position = 0; position <= doc.content.size + 1; position++) {
      const index = positions.findIndex((candidate) => candidate >= position)
      expect(promptTextOffset(doc, position)).toBe(index === -1 ? positions.length - 1 : index)
    }
  })
})
