import {
  createClaudeStructuredLaunchResolver,
  createCodexStructuredLaunchResolver
} from '../runtime/structured-agent-launch-composition.test-support'
import { describe, expect, it, vi } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { CLAUDE_PLUGIN_DIR_FLAG, type ClaudeCliFlag } from '../claude/claude-cli-flag-support'
import {
  adapterFor,
  fakeCodex,
  identityFor
} from '../codex/codex-structured-session-adapter-fixture'
import { agentSessionRecordFixture } from './agent-session-record-test-fixture'
import { createNativeChatVisualsDelivery } from './native-chat-visuals-delivery'

const SKILL = { pluginDir: '/app/plugin', skillsRoot: '/app/plugin/skills' }
const MANUAL = { approvalPolicy: 'on-request', sandbox: 'workspace-write' } as const
function delivery(isEnabled: () => boolean) {
  const prepareVisuals = createNativeChatVisualsDelivery({
    logger: { warn: vi.fn(), error: vi.fn() },
    isEnabled,
    resolveSkill: async () => SKILL
  })
  return { prepareVisuals }
}

describe('inline visuals launch preference', () => {
  it('starts Claude without visuals while preserving configured plugins, user folders and attachment access', async () => {
    const sessionId = 'claude-disabled'
    const { prepareVisuals } = delivery(() => false)
    const supports = vi.fn(async (_flag: ClaudeCliFlag) => true)
    const record = agentSessionRecordFixture({ sessionId })
    const launch = await createClaudeStructuredLaunchResolver({
      store: { getRecord: () => record, pinLaunchDirectory: vi.fn() },
      resolveWorkspacePath: async () => '/repo',
      resolveCommand: () => '/bin/claude',
      resolveAuthPolicy: () => ({ account: 'system' }),
      resolveLaunchArgs: () => ['--add-dir', '/user/notes', '--plugin-dir', '/user/plugin'],
      resolveEnv: () => ({ KEEP: 'yes' }),
      resolveInheritedEnv: async () => ({ PATH: '/bin' }),
      attachmentDirectory: '/state/agent-session-attachments',
      hasTranscript: async () => false,
      cliFlags: { supports },
      prepareVisuals
    })({ identity: { ...identityFor(sessionId), agent: 'claude', providerHandle: null } })
    expect(launch.options).not.toHaveProperty('plugins')
    expect(launch.options.extraArgs).toHaveProperty('plugin-dir', '/user/plugin')
    expect(launch.options.additionalDirectories).toEqual([
      '/user/notes',
      '/state/agent-session-attachments'
    ])
    expect(launch.env?.KEEP).toBe('yes')
    expect(supports.mock.calls.map(([flag]) => flag)).not.toContain(CLAUDE_PLUGIN_DIR_FLAG)
  })

  it('gives new Codex chats the current preference without changing another live chat', async () => {
    let enabled = true
    const { prepareVisuals } = delivery(() => enabled)
    const codex = fakeCodex({})
    const resolveLaunch = createCodexStructuredLaunchResolver({
      store: {
        getRecord: (sessionId) =>
          agentSessionRecordFixture({
            sessionId,
            provider: 'codex',
            accountHome: { variable: 'CODEX_HOME', path: '/home/codex' }
          }),
        pinLaunchDirectory: vi.fn()
      },
      resolveWorkspacePath: async () => '/repo',
      resolveCommand: () => '/bin/codex',
      resolveLaunchArgs: () => [],
      resolvePermissionPolicy: () => MANUAL,
      resolveEnvironment: async () => ({ KEEP: 'yes' }),
      prepareVisuals
    })
    const adapter = adapterFor(codex, {}, [], { resolveLaunch })
    const start = (sessionId: string) =>
      adapter.acquire({
        identity: {
          ...identityFor(sessionId),
          hostId: LOCAL_EXECUTION_HOST_ID,
          providerHandle: null
        },
        fence: 1,
        spawnToken: sessionId
      })
    try {
      await start('first')
      const first = codex.connections[0]!
      const firstCalls = [...first.calls]
      expect(first.calls.find(({ method }) => method === 'skills/extraRoots/set')?.params).toEqual({
        extraRoots: [SKILL.skillsRoot]
      })
      // The agent writes into its own workspace, so no extra writable folder is configured.
      expect(
        first.calls.find(({ method }) => method === 'thread/start')?.params
      ).not.toHaveProperty('config')

      enabled = false
      await start('disabled')
      const disabled = codex.connections[1]!
      expect(disabled.launch.env?.KEEP).toBe('yes')
      expect(disabled.calls.map(({ method }) => method)).not.toContain('skills/extraRoots/set')
      expect(first.closed).toBe(false)
      expect(first.calls).toEqual(firstCalls)

      enabled = true
      await start('reenabled')
      const reenabled = codex.connections[2]!
      expect(
        reenabled.calls.find(({ method }) => method === 'skills/extraRoots/set')?.params
      ).toEqual({ extraRoots: [SKILL.skillsRoot] })
      expect(first.closed).toBe(false)
      expect(first.calls).toEqual(firstCalls)
    } finally {
      await adapter.closeAll()
    }
  })
})
