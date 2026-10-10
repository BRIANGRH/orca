import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionOptionsResult } from '../../../src/shared/agent-session-wire'
import type { RpcClient } from '../transport/rpc-client'
import type { StructuredAgentSessionMutate } from './mobile-structured-agent-session-rpc'
import { useMobileStructuredAgentOptions } from './use-mobile-structured-agent-options'

function optionsFor(permissionMode?: string): AgentSessionOptionsResult {
  return {
    models: [{ id: 'gpt-live', label: 'GPT Live', isDefault: true, efforts: [] }],
    current: { model: 'gpt-live', ...(permissionMode ? { permissionMode } : {}) }
  }
}

/** Answers each options read with the next mode in `modes`, repeating the last. */
function optionsClient(...modes: (string | undefined)[]) {
  let reads = 0
  const client: RpcClient = {
    sendRequest: async (method: string) => {
      if (method === 'agentSession.modelCatalog') {
        return {
          id: 'rpc-1',
          ok: false as const,
          error: { code: 'method_not_found', message: 'Unknown method' },
          _meta: { runtimeId: 'runtime-1' }
        }
      }
      const result =
        method === 'agentSession.options'
          ? optionsFor(modes[Math.min(reads++, modes.length - 1)])
          : {}
      return { id: 'rpc-1', ok: true as const, result, _meta: { runtimeId: 'runtime-1' } }
    },
    subscribe: () => () => {},
    updateTerminalSubscriptionViewport: () => {},
    getState: () => 'connected',
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => null,
    onStateChange: () => () => {},
    notifyForeground: () => {},
    close: () => {}
  }
  return { client, reads: () => reads }
}

type Controller = ReturnType<typeof useMobileStructuredAgentOptions>
type ProbeProps = { client: RpcClient; fence: number; optionStamp: string }

const mutate: StructuredAgentSessionMutate = vi.fn()

async function mountOptions(props: ProbeProps) {
  const rendered: { current: Controller | null } = { current: null }
  function Probe(probe: ProbeProps): null {
    rendered.current = useMobileStructuredAgentOptions({
      agent: 'codex',
      client: probe.client,
      sessionId: 'session-1',
      enabled: true,
      fence: probe.fence,
      mutate,
      optionStamp: probe.optionStamp
    })
    return null
  }
  let renderer: ReactTestRenderer | null = null
  const settle = () =>
    act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
  await act(async () => {
    renderer = create(createElement(Probe, props))
  })
  await settle()
  return {
    permission: () => {
      const entry = rendered.current?.optionSnapshot.find(
        (descriptor) => descriptor.id === 'permissionMode'
      )
      return entry?.kind.type === 'select' ? entry.kind.currentValue : null
    },
    rerender: async (next: Partial<ProbeProps>) => {
      await act(async () => {
        renderer?.update(createElement(Probe, { ...props, ...next }))
      })
      await settle()
    },
    unmount: () => act(async () => renderer?.unmount())
  }
}

describe('the permission mode on the phone', () => {
  it('re-reads once when the host status moves, so a desktop pick shows here', async () => {
    const rpc = optionsClient('ask', 'full-access')
    const options = await mountOptions({
      client: rpc.client,
      fence: 1,
      optionStamp: 'gpt-live|ask'
    })
    expect(options.permission()).toBe('ask')
    expect(rpc.reads()).toBe(1)

    await options.rerender({ optionStamp: 'gpt-live|full-access' })
    expect(options.permission()).toBe('full-access')
    expect(rpc.reads()).toBe(2)
    await options.unmount()
  })

  it('keeps the mode across a fence of the same chat', async () => {
    const rpc = optionsClient('auto')
    const options = await mountOptions({ client: rpc.client, fence: 1, optionStamp: '' })
    expect(options.permission()).toBe('auto')
    await options.rerender({ fence: 2 })
    expect(options.permission()).toBe('auto')
    await options.unmount()
  })

  it('shows no pill for a host that states no mode', async () => {
    const rpc = optionsClient(undefined)
    const options = await mountOptions({ client: rpc.client, fence: 1, optionStamp: '' })
    expect(rpc.reads()).toBe(1)
    expect(options.permission()).toBeNull()
    await options.unmount()
  })
})
