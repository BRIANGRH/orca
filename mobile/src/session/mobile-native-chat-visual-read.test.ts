import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import {
  cachedMobileNativeChatVisual,
  readMobileNativeChatVisual,
  resetMobileNativeChatVisualCacheForTest,
  type MobileNativeChatVisualSource
} from './mobile-native-chat-visual-read'

const REVISION_A = 'a'.repeat(32)
const REVISION_B = 'b'.repeat(32)

function success(result: unknown): RpcResponse {
  return { id: '1', ok: true, result }
}

function failure(code: string): RpcResponse {
  return { id: '1', ok: false, error: { code, message: code } }
}

function sourceWith(sendRequest: ReturnType<typeof vi.fn>): MobileNativeChatVisualSource {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the reader calls only sendRequest; the rest of RpcClient is connection lifecycle it never touches.
  const client = { sendRequest } as unknown as RpcClient
  return { client, sessionId: 'session-1' }
}

afterEach(() => {
  resetMobileNativeChatVisualCacheForTest()
})

const page = (path: string, legacy = false) => ({ path, legacy })

describe('readMobileNativeChatVisual', () => {
  it('reads the visual by session and page path, then caches it', async () => {
    const sendRequest = vi
      .fn()
      .mockResolvedValue(success({ ok: true, revision: REVISION_A, sizeBytes: 3, html: '<p>' }))
    const source = sourceWith(sendRequest)

    await expect(readMobileNativeChatVisual(source, page('chart.html'))).resolves.toEqual({
      kind: 'ready',
      html: '<p>',
      revision: REVISION_A
    })
    expect(sendRequest).toHaveBeenCalledWith(
      'agentSession.readVisual',
      { sessionId: 'session-1', path: 'chart.html' },
      expect.objectContaining({ timeoutMs: expect.any(Number) })
    )
    expect(cachedMobileNativeChatVisual(source, page('chart.html'))).toEqual({
      html: '<p>',
      revision: REVISION_A
    })
  })

  it('revalidates with the held revision and keeps the cached bytes on unchanged', async () => {
    const sendRequest = vi
      .fn()
      .mockResolvedValueOnce(success({ ok: true, revision: REVISION_A, sizeBytes: 3, html: '<p>' }))
      .mockResolvedValueOnce(
        success({ ok: true, revision: REVISION_A, sizeBytes: 3, unchanged: true })
      )
    const source = sourceWith(sendRequest)
    await readMobileNativeChatVisual(source, page('chart.html'))

    await expect(readMobileNativeChatVisual(source, page('chart.html'))).resolves.toEqual({
      kind: 'ready',
      html: '<p>',
      revision: REVISION_A
    })
    expect(sendRequest.mock.calls[1]?.[1]).toEqual({
      sessionId: 'session-1',
      path: 'chart.html',
      knownRevision: REVISION_A
    })
  })

  it('replaces the cached bytes when the host has a new revision', async () => {
    const sendRequest = vi
      .fn()
      .mockResolvedValueOnce(success({ ok: true, revision: REVISION_A, sizeBytes: 3, html: '<p>' }))
      .mockResolvedValueOnce(
        success({ ok: true, revision: REVISION_B, sizeBytes: 4, html: '<hr>' })
      )
    const source = sourceWith(sendRequest)
    await readMobileNativeChatVisual(source, page('chart.html'))
    await readMobileNativeChatVisual(source, page('chart.html'))
    expect(cachedMobileNativeChatVisual(source, page('chart.html'))?.revision).toBe(REVISION_B)
  })

  it('drops the cached bytes when the host refuses a visual it served before', async () => {
    const source = sourceWith(
      vi
        .fn()
        .mockResolvedValueOnce(
          success({ ok: true, revision: REVISION_A, sizeBytes: 3, html: '<p>' })
        )
        .mockResolvedValueOnce(success({ ok: false, error: 'not_found' }))
    )
    await readMobileNativeChatVisual(source, page('chart.html'))
    await expect(readMobileNativeChatVisual(source, page('chart.html'))).resolves.toEqual({
      kind: 'refused'
    })
    expect(cachedMobileNativeChatVisual(source, page('chart.html'))).toBeNull()
  })

  it('reads a host verdict and an older host as refused', async () => {
    for (const response of [
      success({ ok: false, error: 'not_found' }),
      success({ ok: false, error: 'some_future_error' }),
      failure('method_not_found'),
      failure('forbidden')
    ]) {
      resetMobileNativeChatVisualCacheForTest()
      const source = sourceWith(vi.fn().mockResolvedValue(response))
      await expect(readMobileNativeChatVisual(source, page('chart.html'))).resolves.toEqual({
        kind: 'refused'
      })
    }
  })

  it('reads an error reply and a malformed reply as no verdict, keeping the cache', async () => {
    for (const response of [
      failure('runtime_error'),
      success({ ok: true, revision: 'not-hex', html: '' }),
      success('<html>')
    ]) {
      resetMobileNativeChatVisualCacheForTest()
      const sendRequest = vi
        .fn()
        .mockResolvedValueOnce(
          success({ ok: true, revision: REVISION_A, sizeBytes: 3, html: '<p>' })
        )
        .mockResolvedValueOnce(response)
      const source = sourceWith(sendRequest)
      await readMobileNativeChatVisual(source, page('chart.html'))
      await expect(readMobileNativeChatVisual(source, page('chart.html'))).resolves.toEqual({
        kind: 'unreachable'
      })
      expect(cachedMobileNativeChatVisual(source, page('chart.html'))).not.toBeNull()
    }
  })

  it('reads a transport failure as unreachable, never as refused', async () => {
    const source = sourceWith(vi.fn().mockRejectedValue(new Error('socket closed')))
    await expect(readMobileNativeChatVisual(source, page('chart.html'))).resolves.toEqual({
      kind: 'unreachable'
    })
  })

  it('treats an unchanged answer for a revision it never sent as unreachable and drops the entry', async () => {
    const source = sourceWith(
      vi.fn().mockResolvedValue(success({ ok: true, revision: REVISION_A, unchanged: true }))
    )
    await expect(readMobileNativeChatVisual(source, page('chart.html'))).resolves.toEqual({
      kind: 'unreachable'
    })
    expect(cachedMobileNativeChatVisual(source, page('chart.html'))).toBeNull()
  })

  it('shares one request between concurrent reads of the same visual', async () => {
    let resolve: (response: RpcResponse) => void = () => {}
    const sendRequest = vi.fn(
      () =>
        new Promise<RpcResponse>((settle) => {
          resolve = settle
        })
    )
    const source = sourceWith(sendRequest)
    const first = readMobileNativeChatVisual(source, page('chart.html'))
    const second = readMobileNativeChatVisual(source, page('chart.html'))
    resolve(success({ ok: true, revision: REVISION_A, sizeBytes: 3, html: '<p>' }))
    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
    expect(sendRequest).toHaveBeenCalledTimes(1)
  })

  it('keys the cache by client and session, so another host or chat never sees this one', async () => {
    const source = sourceWith(
      vi
        .fn()
        .mockResolvedValue(success({ ok: true, revision: REVISION_A, sizeBytes: 3, html: '<p>' }))
    )
    await readMobileNativeChatVisual(source, page('chart.html'))
    expect(cachedMobileNativeChatVisual(source, page('chart.html'))).not.toBeNull()
    expect(
      cachedMobileNativeChatVisual({ ...source, sessionId: 'other' }, page('chart.html'))
    ).toBeNull()
    const otherHost = sourceWith(vi.fn()).client
    expect(
      cachedMobileNativeChatVisual({ ...source, client: otherHost }, page('chart.html'))
    ).toBeNull()
  })

  it('evicts the oldest visuals past the entry bound', async () => {
    const source = sourceWith(
      vi
        .fn()
        .mockResolvedValue(success({ ok: true, revision: REVISION_A, sizeBytes: 3, html: '<p>' }))
    )
    for (let index = 0; index < 17; index += 1) {
      await readMobileNativeChatVisual(source, page(`v${index}.html`))
    }
    expect(cachedMobileNativeChatVisual(source, page('v0.html'))).toBeNull()
    expect(cachedMobileNativeChatVisual(source, page('v16.html'))).not.toBeNull()
  })
})

describe('legacy visuals', () => {
  it('asks an older host for its per-chat folder page by the field it knows', async () => {
    const sendRequest = vi
      .fn()
      .mockResolvedValue(success({ ok: true, revision: REVISION_A, sizeBytes: 3, html: '<p>' }))
    const source = sourceWith(sendRequest)
    await readMobileNativeChatVisual(source, page('chart.html', true))
    expect(sendRequest).toHaveBeenCalledWith(
      'agentSession.readVisual',
      { sessionId: 'session-1', file: 'chart.html' },
      expect.anything()
    )
    expect(cachedMobileNativeChatVisual(source, page('chart.html'))).toBeNull()
  })
})
