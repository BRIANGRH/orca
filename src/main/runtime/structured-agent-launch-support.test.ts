import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentSessionRecordFixture } from '../../shared/agent-session-record.test-fixture'
import { acpLaunchSpecFor } from '../acp/acp-launch-specs'
import { createAcpStructuredLaunchResolver } from '../acp/acp-structured-launch-resolution'
import { structuredAgentSupportsLaunch } from './structured-agent-launch-support'
import {
  createStructuredAgentEnvironmentResolvers,
  resetHostShellEnvironmentForTests
} from './structured-agent-shell-environment'

const { probeAgentCliVersion, loginShell } = vi.hoisted(() => {
  const loginShell: {
    env: Record<string, string>
    capture: ReturnType<typeof vi.fn>
  } = {
    env: {},
    // Each call is one shell run; a test can hold one open to see who shares it.
    capture: vi.fn(async () => ({ status: 'captured', env: loginShell.env }))
  }
  return { probeAgentCliVersion: vi.fn(), loginShell }
})
vi.mock('../agent-cli-version-probe', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  probeAgentCliVersion
}))
vi.mock('../startup/login-shell-environment', () => ({
  LOGIN_SHELL_SPAWN_TIMEOUT_MS: 5000,
  resolveLoginShellEnvironment: async () => loginShell.env,
  captureLoginShellEnvironment: loginShell.capture
}))

let bin: string
const asked: { program: string; cwd: string; env: Record<string, string> }[] = []
function installedVersion(version: string): void {
  probeAgentCliVersion.mockImplementation(async (input, supports) => {
    asked.push(input)
    return supports(version)
  })
}

const settings = {
  agentDefaultEnv: { opencode: { OPENCODE_EXTRA: '1' } },
  nativeChatInheritShellEnvironment: true,
  nativeChatShellEnvironmentVariables: []
}
const runtime = {
  requireStore: () => ({ getSettings: () => settings }),
  resolveRuntimeFileTarget: vi.fn(async () => ({ worktree: { path: '/repo/worktree' } }))
}

beforeEach(async () => {
  asked.length = 0
  bin = await mkdtemp(join(tmpdir(), 'orca-opencode-bin-'))
  const opencode = join(bin, 'opencode')
  await writeFile(opencode, '#!/bin/sh\n')
  await chmod(opencode, 0o755)
  loginShell.env = { PATH: bin, HOME: '/home/user' }
  loginShell.capture.mockClear()
  resetHostShellEnvironmentForTests()
})
afterEach(async () => {
  probeAgentCliVersion.mockReset()
  runtime.resolveRuntimeFileTarget.mockClear()
  await rm(bin, { recursive: true, force: true })
})

describe('structuredAgentSupportsLaunch', () => {
  it('asks nothing for an agent whose location alone decides', async () => {
    expect(await structuredAgentSupportsLaunch('grok', 'id:workspace-1', runtime)).toBe(true)
    expect(probeAgentCliVersion).not.toHaveBeenCalled()
    expect(runtime.resolveRuntimeFileTarget).not.toHaveBeenCalled()
  })

  it('allows stable OpenCode 1.x and 2.x, asking in the workspace with the launch env', async () => {
    for (const [version, supported] of [
      ['1.18.31', true],
      ['2.0.14', true],
      ['2.0.21', true],
      ['1.18.30', false],
      ['2.0.13', false],
      ['2.1.0-beta.1', false],
      ['3.0.0', false]
    ] as const) {
      installedVersion(version)
      expect(await structuredAgentSupportsLaunch('opencode', 'id:workspace-1', runtime)).toBe(
        supported
      )
    }
    expect(asked[0]).toMatchObject({
      cwd: '/repo/worktree',
      env: { PATH: bin, OPENCODE_EXTRA: '1', OPENCODE_CLIENT: 'acp' }
    })
  })

  it.skipIf(process.platform === 'win32')(
    'shares one shell reread between create checks and launches that find no OpenCode',
    async () => {
      installedVersion('1.18.31')
      // A name only the reread PATH has, so no OpenCode on the machine running the test answers.
      const name = `opencode-installed-${process.pid}`
      await writeFile(join(bin, name), '#!/bin/sh\n')
      await chmod(join(bin, name), 0o755)
      const installing = {
        ...runtime,
        requireStore: () => ({
          getSettings: () => ({ ...settings, agentCmdOverrides: { opencode: name } })
        })
      }
      loginShell.env = { PATH: join(bin, 'not-installed'), HOME: '/home/user' }
      // A chat launched from this host reads the same snapshot.
      const launches = createStructuredAgentEnvironmentResolvers({})
      expect((await launches.resolveBaseEnvironment()).PATH).toBe(join(bin, 'not-installed'))
      const reread = Promise.withResolvers<{ status: 'captured'; env: Record<string, string> }>()
      loginShell.capture.mockReturnValueOnce(reread.promise)
      const checks = Array.from({ length: 8 }, () =>
        structuredAgentSupportsLaunch('opencode', 'id:workspace-1', installing)
      )
      const launchMiss = launches.refreshAfterMissingProgram()
      await vi.waitFor(() => expect(loginShell.capture).toHaveBeenCalledTimes(2))
      reread.resolve({ status: 'captured', env: { PATH: bin, HOME: '/home/user' } })
      expect(await Promise.all(checks)).toEqual(Array(8).fill(true))
      await launchMiss
      expect(loginShell.capture).toHaveBeenCalledTimes(2)
      expect(asked.map(({ program }) => program)).toEqual(Array(8).fill(join(bin, name)))
      expect((await launches.resolveBaseEnvironment()).PATH).toBe(bin)
    }
  )

  it('never rereads the shell for an OpenCode that is installed but unsupported', async () => {
    installedVersion('1.18.30')
    expect(await structuredAgentSupportsLaunch('opencode', 'id:workspace-1', runtime)).toBe(false)
    expect(await structuredAgentSupportsLaunch('opencode', 'id:workspace-1', runtime)).toBe(false)
    // Only the first read of the shell; neither refusal asked for another.
    expect(loginShell.capture).toHaveBeenCalledOnce()
    expect(asked).toHaveLength(2)
  })

  it('refuses when the version cannot be read', async () => {
    probeAgentCliVersion.mockResolvedValue(false)
    expect(await structuredAgentSupportsLaunch('opencode', 'id:workspace-1', runtime)).toBe(false)
  })

  it.skipIf(process.platform === 'win32')(
    'asks about the same binary the launch then spawns',
    async () => {
      installedVersion('1.18.31')
      await structuredAgentSupportsLaunch('opencode', 'id:workspace-1', runtime)
      const launch = await createAcpStructuredLaunchResolver(acpLaunchSpecFor('opencode')!, {
        store: {
          getRecord: () => ({
            ...agentSessionRecordFixture(),
            provider: 'opencode',
            providerHandleChain: [],
            accountHome: { kind: 'opencode', locator: { kind: 'unmanaged' } }
          }),
          pinLaunchDirectory: vi.fn()
        },
        readJournal: () => null,
        resolveWorkspacePath: async () => '/repo/worktree',
        resolveEnvironment: async () => loginShell.env,
        resolveLaunchEnv: () => settings.agentDefaultEnv.opencode,
        inheritedEnv: {}
      })({
        identity: {
          sessionId: 'session-alpha-1',
          workspaceId: 'workspace-1',
          hostId: 'local',
          agent: 'opencode',
          providerHandle: null
        }
      })
      expect(launch.command).toBe(join(bin, 'opencode'))
      expect(asked.map(({ program }) => program)).toEqual([launch.command, launch.command])
    }
  )
})
