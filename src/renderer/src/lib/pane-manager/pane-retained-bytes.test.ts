import { describe, expect, it, vi } from 'vitest'
import type { Terminal } from '@xterm/xterm'

vi.mock('./pane-inline-images', () => ({
  getTerminalInlineImageBytes: (terminal: { imageBytes?: number }) => terminal.imageBytes ?? 0
}))

const { estimatePanesRetainedBytes } = await import('./pane-retained-bytes')

function fakeTerminal(cols: number, normal: number, alternate: number, imageBytes = 0): Terminal {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the estimate reads only cols, buffer lengths and the mocked image size.
  return {
    cols,
    buffer: { normal: { length: normal }, alternate: { length: alternate } },
    imageBytes
  } as unknown as Terminal
}

describe('estimatePanesRetainedBytes', () => {
  it('grows with columns x rows across every pane, plus a fixed cost and image caches', () => {
    const small = estimatePanesRetainedBytes([{ terminal: fakeTerminal(80, 100, 0) }])
    const wide = estimatePanesRetainedBytes([{ terminal: fakeTerminal(200, 100, 0) }])
    const deep = estimatePanesRetainedBytes([{ terminal: fakeTerminal(80, 50_000, 0) }])
    expect(wide).toBeGreaterThan(small)
    expect(deep).toBeGreaterThan(40 * 1024 * 1024)
    const split = estimatePanesRetainedBytes([
      { terminal: fakeTerminal(80, 100, 0) },
      { terminal: fakeTerminal(80, 100, 0) }
    ])
    expect(split).toBe(2 * small)
    const withImages = estimatePanesRetainedBytes([
      { terminal: fakeTerminal(80, 100, 0, 5 * 1024 * 1024) }
    ])
    expect(withImages - small).toBe(5 * 1024 * 1024)
    expect(estimatePanesRetainedBytes([{ terminal: fakeTerminal(80, 100, 24) }])).toBeGreaterThan(
      small
    )
  })
})
