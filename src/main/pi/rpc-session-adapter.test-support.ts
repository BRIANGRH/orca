// The Pi adapter against a scripted RPC connection and the real journal timeline.

import { afterEach, expect, vi } from 'vitest'
import type { AgentSessionProcessIdentity } from '../../shared/agent-session-record'
import type { StructuredAgentSessionAcquireInput } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import {
  closeProviderTimelineRigs,
  openProviderTimelineRig
} from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import type { JsonlRpcAgentConnectionOptions } from '../jsonl-rpc/agent-connection'
import type { JsonlRpcRecord } from '../jsonl-rpc/peer'
import type { PiRpcConnection } from './rpc-session'
import type { ProviderProcessLaunch } from '../provider-process/provider-process-launch'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { PiRpcSessionAdapter } from './rpc-session-adapter'

export const sessionId = 'session-timeline'
export const file = '/host/account/sessions/session.jsonl'
const state = {
  sessionFile: file,
  isStreaming: false,
  isCompacting: false,
  model: { provider: 'anthropic', id: 'model-1' }
}
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup()
  }
  await closeProviderTimelineRigs()
})

export class FakeConnection implements PiRpcConnection {
  pid = 4123
  closed = false
  rootVerdict: 'live' | 'unverifiable' | 'exited' = 'live'
  processless = false
  deferExit = false
  lastCloseResult: PiRpcConnection['lastCloseResult'] = null
  closeResult: Awaited<ReturnType<PiRpcConnection['close']>> = { root: 'exited', tree: 'exited' }
  readonly sent: JsonlRpcRecord[] = []
  readonly requests: string[] = []
  private readonly exitListeners: (() => void)[] = []
  requestOverride?: (command: string) => Promise<unknown> | undefined
  abortRequest?: () => void
  constructor(readonly handlers: JsonlRpcAgentConnectionOptions) {}
  async request(command: string): Promise<unknown> {
    this.requests.push(command)
    const override = this.requestOverride?.(command)
    if (override) {
      return override
    }
    if (command === 'get_state') {
      return state
    }
    if (command === 'get_available_models') {
      return { models: [state.model] }
    }
    if (command === 'get_commands') {
      return { commands: [{ name: 'help' }] }
    }
    if (command === 'set_thinking_level') {
      throw new Error('saved effort unavailable')
    }
    return {}
  }
  async send(frame: JsonlRpcRecord): Promise<void> {
    this.sent.push(frame)
  }
  async close(): Promise<Awaited<ReturnType<PiRpcConnection['close']>>> {
    this.abortRequest?.()
    this.closed = true
    this.rootVerdict = this.closeResult.root
    this.lastCloseResult = this.closeResult
    if (this.closeResult.root === 'exited' && !this.deferExit) {
      this.exit()
    }
    return this.closeResult
  }
  pauseReading(): void {}
  resumeReading(): void {}
  onExit(listener: () => void): void {
    if (this.rootVerdict === 'exited') {
      listener()
    } else {
      this.exitListeners.push(listener)
    }
  }
  receive(frame: JsonlRpcRecord): void {
    this.handlers.onRecord?.(frame)
  }
  exit(error = new Error('child exited')): void {
    this.closed = true
    this.rootVerdict = 'exited'
    for (const listener of this.exitListeners.splice(0)) {
      listener()
    }
    this.handlers.onExit?.(error, {
      expected: false,
      exit: { code: 1, signal: null, processless: false }
    })
  }
}

export async function setup(
  options: Readonly<Record<string, string>> = {},
  eventSink?: (sink: StructuredAgentSessionEventSink) => StructuredAgentSessionEventSink
) {
  const rig = await openProviderTimelineRig({ agent: 'pi', sessionId })
  const connections: FakeConnection[] = []
  const lifecycle = vi.fn<(...args: unknown[]) => void>(),
    settled = vi.fn<(...args: unknown[]) => void>(),
    idle = vi.fn<(...args: unknown[]) => void>()
  const onSpawned = vi.fn(async (_process: AgentSessionProcessIdentity) => {
    expect(connections.at(-1)?.requests).toEqual([])
  })
  const input: StructuredAgentSessionAcquireInput = {
    identity: {
      sessionId,
      workspaceId: 'folder-1',
      hostId: 'local',
      agent: 'pi',
      providerHandle: null
    },
    fence: 7,
    spawnToken: 'spawn-token',
    options,
    events: eventSink?.(rig.eventSink) ?? rig.eventSink,
    onSpawned
  }
  const resolveLaunch = vi.fn(async () => ({
    command: '/host/bin/pi',
    cwd: '/host/folder',
    fullAccess: true,
    previous: null
  }))
  const openConnection = vi.fn(
    (_launch: ProviderProcessLaunch, handlers: JsonlRpcAgentConnectionOptions) => {
      const connection = new FakeConnection(handlers)
      connections.push(connection)
      return connection
    }
  )
  const adapter = new PiRpcSessionAdapter({
    resolveLaunch,
    readProcessStartTime: async () => 12345,
    openConnection,
    onLifecycle: lifecycle,
    onSettled: settled,
    onIdle: idle,
    logger: { warn: vi.fn(), error: vi.fn() }
  })
  const acquired = await adapter.acquire(input)
  const connection = connections[0]
  if (!connection) {
    throw new Error('connection missing')
  }
  cleanups.push(async () => {
    await adapter.closeAll().catch(() => {})
    await adapter.drainObservedExits()
    adapter.acknowledgeSessionRelease(sessionId)
  })
  return {
    adapter,
    connection,
    rig,
    acquired,
    onSpawned,
    lifecycle,
    settled,
    idle,
    input,
    resolveLaunch,
    openConnection,
    connections
  }
}
