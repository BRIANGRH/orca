/**
 * Renderer memory a mounted terminal pane holds, for the hidden-view budget.
 * Calibrated against measured renderer private memory; ranking and budget
 * decisions need the right order of magnitude, not byte accuracy.
 */
import type { Terminal } from '@xterm/xterm'
import { getTerminalInlineImageBytes } from './pane-inline-images'

// xterm stores each cell as 3 x uint32 in a typed array outside the V8 heap.
const BYTES_PER_CELL = 12
// Per-row BufferLine object, its typed-array header and the circular list slot.
const BYTES_PER_ROW = 500
// The xterm instance, its DOM and addons, independent of how much it printed.
const PANE_FIXED_BYTES = 4 * 1024 * 1024

export function estimatePanesRetainedBytes(panes: readonly { terminal: Terminal }[]): number {
  let bytes = 0
  for (const { terminal } of panes) {
    const rows = terminal.buffer.normal.length + terminal.buffer.alternate.length
    bytes +=
      PANE_FIXED_BYTES +
      rows * (terminal.cols * BYTES_PER_CELL + BYTES_PER_ROW) +
      getTerminalInlineImageBytes(terminal)
  }
  return bytes
}
