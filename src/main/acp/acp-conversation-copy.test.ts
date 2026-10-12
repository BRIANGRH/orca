import { afterEach, describe, expect, it } from 'vitest'
import type { AgentSessionJournalIdentity } from '../../shared/agent-session-journal-types'
import { acpLaunchSpecFor, type AcpLaunchSpec } from './acp-launch-specs'
import {
  FakeAcpChild,
  openAcpAdapterRig,
  type AcpAdapterRig,
  PROVIDER_SESSION
} from './acp-structured-adapter.test-support'
import { copyAcpConversation } from './acp-conversation-copy'

const OMP = acpLaunchSpecFor('omp')!
const OPENCODE = acpLaunchSpecFor('opencode')!
const FORKS = { agentCapabilities: { loadSession: true, sessionCapabilities: { fork: {} } } }
const FORKS_INITIALIZED = { protocolVersion: 1, ...FORKS }
const identity = (agent: string): AgentSessionJournalIdentity => ({
  sessionId: 'orca-chat-1',
  workspaceId: 'workspace-1',
  hostId: 'local',
  agent,
  providerHandle: null
})

const launchOf = (spec: AcpLaunchSpec) => ({
  spec,
  command: `/opt/bin/${spec.command}`,
  args: ['acp'],
  cwd: '/workspace/project',
  env: {},
  envToDelete: [],
  fullAccess: false,
  resume: null
})

const rigs: AcpAdapterRig[] = []
afterEach(async () => {
  await Promise.all(rigs.splice(0).map((rig) => rig.adapter.closeAll()))
})

async function open(options: Parameters<typeof openAcpAdapterRig>[0]): Promise<AcpAdapterRig> {
  const rig = await openAcpAdapterRig(options)
  rigs.push(rig)
  return rig
}

describe('copying a chat conversation for the CLI', () => {
  it.each([OMP, OPENCODE])(
    'has $agent copy the conversation under the chat launch and answers the copy',
    async (spec) => {
      const reads: string[] = []
      const rig = await open({
        spec,
        initialize: FORKS,
        deps: {
          // The unsealed launch a recovery read uses, with the keys the host strips from a child.
          readLaunch: async (chat) => {
            reads.push(chat.sessionId)
            return { ...launchOf(spec), envToDelete: ['ORCA_PANE_KEY', 'ORCA_AGENT_HOOK_PORT'] }
          }
        },
        script: (agent) =>
          agent.on('session/fork', (frame) => agent.reply(frame, { sessionId: 'copy-1' }))
      })

      await expect(
        rig.adapter.copyConversation({
          identity: identity(spec.agent),
          providerSessionId: PROVIDER_SESSION
        })
      ).resolves.toBe('copy-1')

      expect(rig.sent('session/fork').map((frame) => frame.params)).toEqual([
        { sessionId: PROVIDER_SESSION, cwd: '/workspace/project', mcpServers: [] }
      ])
      // Only the copy is made: the chat's conversation is never loaded, resumed or prompted.
      expect(rig.child().agent.frames.map((frame) => frame.method)).toEqual([
        'initialize',
        'session/fork'
      ])
      // The short-lived agent is closed, and runs the chat's launch unsealed, for no chat or pane.
      expect(rig.child().closes).toBe(1)
      expect(reads).toEqual(['orca-chat-1'])
      expect(rig.child().launch.envToDelete).toEqual(
        expect.arrayContaining(['ORCA_PANE_KEY', 'ORCA_AGENT_HOOK_PORT'])
      )
    }
  )

  it('copies while the chat runs, beside its own agent and without touching it', async () => {
    const rig = await open({
      spec: OMP,
      initialize: FORKS,
      script: (agent) =>
        agent.on('session/fork', (frame) => agent.reply(frame, { sessionId: 'copy-1' }))
    })
    await rig.acquire()
    const chat = rig.child()

    await rig.adapter.copyConversation({
      identity: identity('omp'),
      providerSessionId: PROVIDER_SESSION
    })

    expect(rig.child()).not.toBe(chat)
    expect(chat.closes).toBe(0)
    expect(chat.agent.frames.some((frame) => frame.method === 'session/fork')).toBe(false)
  })

  it('asks for an update when the installed agent does not offer the copy', async () => {
    const rig = await open({ spec: OMP, initialize: { agentCapabilities: { loadSession: true } } })

    await expect(
      rig.adapter.copyConversation({ identity: identity('omp'), providerSessionId: 'p' })
    ).rejects.toThrow('This OMP version cannot copy a chat. Update OMP to resume this chat')
    expect(rig.sent('session/fork')).toEqual([])
    expect(rig.child().closes).toBe(1)
  })

  it('reports a refused copy in plain words and closes the agent', async () => {
    const rig = await open({
      spec: OPENCODE,
      initialize: FORKS,
      script: (agent) =>
        agent.on('session/fork', (frame) =>
          agent.fail(frame, -32603, 'Internal error: Internal service failure')
        )
    })

    await expect(
      rig.adapter.copyConversation({ identity: identity('opencode'), providerSessionId: 'p' })
    ).rejects.toThrow('OpenCode could not copy this chat.')
    expect(rig.child().closes).toBe(1)
  })

  it('gives up on an agent that never answers, and closes it', async () => {
    const children: FakeAcpChild[] = []
    const deps = {
      spec: OMP,
      readLaunch: async () => launchOf(OMP),
      connect: (...args: ConstructorParameters<typeof FakeAcpChild>) => {
        const child = new FakeAcpChild(...args)
        child.agent.on('initialize', (frame) => child.agent.reply(frame, FORKS_INITIALIZED))
        children.push(child)
        return child
      }
    }

    await expect(
      copyAcpConversation(deps, { identity: identity('omp'), providerSessionId: 'p' }, 10)
    ).rejects.toThrow('OMP could not copy this chat.')
    expect(children.map((child) => child.closes)).toEqual([1])
  })
})
