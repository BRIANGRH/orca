// A stopped message's image is read in the session's lane while a send is handed over, so a read
// that stalls (a hung mount) must neither hold that send nor run again on the next one: past its
// limit, or once the preparation gives up, the image is left out like one that no longer reads,
// and the file is not read again while that read is still pending.

// Under the handover's whole-preparation bound, so one stalled image never takes the message's words.
export const STOPPED_IMAGE_READ_TIMEOUT_MS = 1_000

const GAVE_UP: unique symbol = Symbol('stopped image read abandoned')

/** How many abandoned reads of each file have not settled yet. */
const pendingAbandonedReads = new Map<string, number>()

/** `read`'s image, or null to leave it out: it failed, outlasted `timeoutMs` or the preparation
 *  (`signal`), or an abandoned read of `path` is still pending. */
export async function readStoppedImage<T>(
  path: string | undefined,
  read: () => Promise<T | null>,
  signal?: AbortSignal,
  timeoutMs = STOPPED_IMAGE_READ_TIMEOUT_MS
): Promise<T | null> {
  if (signal?.aborted || (path !== undefined && pendingAbandonedReads.has(path))) {
    return null
  }
  const reading = Promise.resolve().then(read)
  let settle: (image: T | null | typeof GAVE_UP) => void = () => {}
  const outcome = new Promise<T | null | typeof GAVE_UP>((resolve) => (settle = resolve))
  const giveUp = (): void => settle(GAVE_UP)
  const timer = setTimeout(giveUp, timeoutMs)
  signal?.addEventListener('abort', giveUp, { once: true })
  reading.then(settle, () => settle(null))
  const image = await outcome
  clearTimeout(timer)
  signal?.removeEventListener('abort', giveUp)
  if (image !== GAVE_UP) {
    return image
  }
  if (path !== undefined) {
    pendingAbandonedReads.set(path, (pendingAbandonedReads.get(path) ?? 0) + 1)
    const settled = (): void => {
      const left = (pendingAbandonedReads.get(path) ?? 1) - 1
      if (left > 0) {
        pendingAbandonedReads.set(path, left)
      } else {
        pendingAbandonedReads.delete(path)
      }
    }
    reading.then(settled, settled)
  }
  return null
}
