import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import { FLOATING_WORKSPACE_WORKTREE_ID } from './floating-workspace'
import {
  cachedMobileNativeChatVisual,
  readMobileNativeChatVisual,
  resetMobileNativeChatVisualCacheForTest,
  type MobileNativeChatVisualSource
} from './mobile-native-chat-visual-read'

function success(result: unknown): RpcResponse {
  return { id: '1', ok: true, result }
}

function failure(code: string): RpcResponse {
  return { id: '1', ok: false, error: { code, message: code } }
}

const page = (content: string) => success({ content, truncated: false, byteLength: content.length })

function sourceWith(
  sendRequest: ReturnType<typeof vi.fn>,
  worktreeId = 'repo::/srv/app'
): MobileNativeChatVisualSource {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the reader calls only sendRequest; the rest of RpcClient is connection lifecycle it never touches.
  const client = { sendRequest } as unknown as RpcClient
  return { client, hostId: 'host-1', worktreeId }
}

afterEach(() => {
  resetMobileNativeChatVisualCacheForTest()
})

describe('readMobileNativeChatVisual', () => {
  it("reads the page as a file in the chat's workspace, then caches it", async () => {
    const sendRequest = vi.fn().mockResolvedValue(page('<p>'))
    const source = sourceWith(sendRequest)

    await expect(readMobileNativeChatVisual(source, 'reports/chart.html')).resolves.toEqual({
      kind: 'ready',
      html: '<p>'
    })
    expect(sendRequest).toHaveBeenCalledWith(
      'files.read',
      { worktree: 'id:repo::/srv/app', relativePath: 'reports/chart.html' },
      expect.objectContaining({ timeoutMs: expect.any(Number) })
    )
    expect(cachedMobileNativeChatVisual(source, 'reports/chart.html')).toBe('<p>')
  })

  it("sends no request for a floating chat: the host would read today's folder, not the chat's", async () => {
    const sendRequest = vi.fn().mockResolvedValue(page('<p>'))
    const source = sourceWith(sendRequest, FLOATING_WORKSPACE_WORKTREE_ID)

    await expect(readMobileNativeChatVisual(source, 'chart.html')).resolves.toEqual({
      kind: 'refused'
    })
    expect(sendRequest).not.toHaveBeenCalled()
  })

  it('reads again on every call and keeps the newest page', async () => {
    const sendRequest = vi
      .fn()
      .mockResolvedValueOnce(page('<p>'))
      .mockResolvedValueOnce(page('<hr>'))
    const source = sourceWith(sendRequest)
    await readMobileNativeChatVisual(source, 'chart.html')
    await readMobileNativeChatVisual(source, 'chart.html')
    expect(cachedMobileNativeChatVisual(source, 'chart.html')).toBe('<hr>')
  })

  it.each([
    ['a host refusal (missing, outside the workspace)', failure('not_found')],
    ['an older host without the method', failure('method_not_found')],
    [
      'a truncated read (over 512 KiB)',
      success({ content: '<p>', truncated: true, byteLength: 600_000 })
    ],
    ['a binary file', success({ content: '', isBinary: true })]
  ])('reads %s as refused and drops the cached page', async (_name, response) => {
    const source = sourceWith(
      vi.fn().mockResolvedValueOnce(page('<p>')).mockResolvedValueOnce(response)
    )
    await readMobileNativeChatVisual(source, 'chart.html')

    await expect(readMobileNativeChatVisual(source, 'chart.html')).resolves.toEqual({
      kind: 'refused'
    })
    expect(cachedMobileNativeChatVisual(source, 'chart.html')).toBeNull()
  })

  it('reads a transport failure or a malformed reply as unreachable, keeping the cache', async () => {
    for (const second of [
      () => Promise.reject(new Error('socket closed')),
      () => Promise.resolve(success('<html>'))
    ]) {
      resetMobileNativeChatVisualCacheForTest()
      const source = sourceWith(
        vi.fn().mockResolvedValueOnce(page('<p>')).mockImplementationOnce(second)
      )
      await readMobileNativeChatVisual(source, 'chart.html')
      await expect(readMobileNativeChatVisual(source, 'chart.html')).resolves.toEqual({
        kind: 'unreachable'
      })
      expect(cachedMobileNativeChatVisual(source, 'chart.html')).toBe('<p>')
    }
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
    const first = readMobileNativeChatVisual(source, 'chart.html')
    const second = readMobileNativeChatVisual(source, 'chart.html')
    resolve(page('<p>'))
    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
    expect(sendRequest).toHaveBeenCalledTimes(1)
  })

  it('keys the cache by host client and workspace', async () => {
    const source = sourceWith(vi.fn().mockResolvedValue(page('<p>')))
    await readMobileNativeChatVisual(source, 'chart.html')
    expect(cachedMobileNativeChatVisual(source, 'chart.html')).not.toBeNull()
    expect(
      cachedMobileNativeChatVisual({ ...source, worktreeId: 'repo::/srv/other' }, 'chart.html')
    ).toBeNull()
    const otherHost = sourceWith(vi.fn()).client
    expect(cachedMobileNativeChatVisual({ ...source, client: otherHost }, 'chart.html')).toBeNull()
  })

  it('evicts the oldest visuals past the entry bound', async () => {
    const source = sourceWith(vi.fn().mockResolvedValue(page('<p>')))
    for (let index = 0; index < 17; index += 1) {
      await readMobileNativeChatVisual(source, `v${index}.html`)
    }
    expect(cachedMobileNativeChatVisual(source, 'v0.html')).toBeNull()
    expect(cachedMobileNativeChatVisual(source, 'v16.html')).not.toBeNull()
  })
})
