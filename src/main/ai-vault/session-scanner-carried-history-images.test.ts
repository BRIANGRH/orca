import { describe, expect, it } from 'vitest'
import {
  CARRIED_HISTORY_MAX_LEADING_ITEMS,
  withoutCarriedHistoryImages
} from './session-scanner-carried-history-images'
import {
  stoppedHistoryElement,
  stoppedHistoryFrame
} from '../native-chat/agent-session-wire/structured-agent-session-stopped-history-frame'

const frame = {
  type: 'input_text',
  text: stoppedHistoryFrame({
    elements: [
      stoppedHistoryElement({
        number: 1,
        text: 'old',
        images: { first: 1, count: 20 },
        omittedImages: 0
      })
    ],
    notIncluded: 0,
    shortened: 0,
    sendImages: { first: 21, count: 0 }
  })
}
const words = { type: 'input_text', text: 'new words' }
const leading = (count: number) =>
  Array.from({ length: count }, (_, index) => ({ type: 'input_text', text: `label ${index}` }))

describe('withoutCarriedHistoryImages', () => {
  it('drops every item ahead of a frame at the furthest place an agent can write one', () => {
    const content = [...leading(CARRIED_HISTORY_MAX_LEADING_ITEMS), frame, words]
    expect(withoutCarriedHistoryImages(content)).toEqual([frame, words])
  })

  it('leaves content alone when its frame sits past the bounded lookahead', () => {
    const content = [...leading(CARRIED_HISTORY_MAX_LEADING_ITEMS + 1), frame, words]
    expect(withoutCarriedHistoryImages(content)).toBe(content)
  })

  it('leaves content without a frame alone', () => {
    const content = [...leading(3), words]
    expect(withoutCarriedHistoryImages(content)).toBe(content)
  })
})
