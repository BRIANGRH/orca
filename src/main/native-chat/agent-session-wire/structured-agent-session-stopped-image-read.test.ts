// A stopped image whose read stalls is left out in time and never read again while that read is stuck.

import { describe, expect, it, vi } from 'vitest'
import { readStoppedImage } from './structured-agent-session-stopped-image-read'

function stalled(): { read: () => Promise<string>; finish: (value: string) => void } {
  let finish: (value: string) => void = () => {}
  const pending = new Promise<string>((resolve) => (finish = resolve))
  return { read: vi.fn(() => pending), finish }
}

describe('reading a stopped image', () => {
  it('answers what it read, and null for a read that failed', async () => {
    expect(await readStoppedImage('/a.png', async () => 'bytes')).toBe('bytes')
    expect(
      await readStoppedImage('/a.png', async () => {
        throw new Error('gone')
      })
    ).toBeNull()
    expect(
      await readStoppedImage('/a.png', () => {
        throw new Error('sync')
      })
    ).toBeNull()
  })

  it('leaves out a read past its limit, and starts none for that file until it settles', async () => {
    const stuck = stalled()
    const started = Date.now()
    expect(await readStoppedImage('/stuck.png', stuck.read, undefined, 30)).toBeNull()
    expect(Date.now() - started).toBeLessThan(500)

    const again = vi.fn(async () => 'bytes')
    const retried = Date.now()
    expect(await readStoppedImage('/stuck.png', again, undefined, 30)).toBeNull()
    expect(Date.now() - retried).toBeLessThan(20)
    expect(again).not.toHaveBeenCalled()
    // Another file still reads.
    expect(await readStoppedImage('/other.png', again, undefined, 30)).toBe('bytes')

    stuck.finish('late')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(await readStoppedImage('/stuck.png', again, undefined, 30)).toBe('bytes')
  })

  it('gives up a pending read when the preparation does, and starts none after', async () => {
    const stuck = stalled()
    const giveUp = new AbortController()
    const reading = readStoppedImage('/pending.png', stuck.read, giveUp.signal, 60_000)
    await new Promise((resolve) => setTimeout(resolve, 0))
    giveUp.abort()
    expect(await reading).toBeNull()

    const next = vi.fn(async () => 'bytes')
    expect(await readStoppedImage('/fresh.png', next, giveUp.signal)).toBeNull()
    // A later preparation does not read the abandoned file while that read is pending.
    expect(await readStoppedImage('/pending.png', next)).toBeNull()
    expect(next).not.toHaveBeenCalled()
    stuck.finish('late')
  })
})
