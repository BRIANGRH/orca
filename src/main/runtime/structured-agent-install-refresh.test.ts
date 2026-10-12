import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { agentSessionRecordFixture } from '../../shared/agent-session-record.test-fixture'
import { resolveCliCommand } from '../../shared/node-cli-command-resolution'
import { acpLaunchSpecFor } from '../acp/acp-launch-specs'
import { resolveClaudeChildEnvSources } from '../claude/claude-structured-child-env'
import {
  createAcpStructuredLaunchResolver,
  createCodexStructuredLaunchResolver
} from './structured-agent-launch-composition.test-support'
import { createStructuredAgentEnvironmentResolvers } from './structured-agent-shell-environment'

const INHERIT_ALL = { inheritAll: true, names: [] }
const GROK = acpLaunchSpecFor('grok')!
const identity = {
  sessionId: 'session-alpha-1',
  workspaceId: 'workspace-1',
  hostId: 'local',
  agent: 'grok',
  providerHandle: null
}
const roots: string[] = []

afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
})

/**
 * A host whose shell profile is read once, after which an agent is installed into a folder only
 * the profile puts on PATH, as in the live check over SSH. `name` is unique so nothing on the
 * machine running the test can answer for it.
 */
async function hostInstallingAfterFirstCapture(name: string) {
  const root = mkdtempSync(join(tmpdir(), 'orca-install-after-capture-'))
  roots.push(root)
  const profileBin = join(root, 'profile-bin')
  let profilePath = '/usr/bin'
  const capture = vi.fn(async () => ({ PATH: profilePath, HOME: root }))
  const environment = createStructuredAgentEnvironmentResolvers({
    resolveEnvironment: capture,
    resolveShellEnvironmentPolicy: () => INHERIT_ALL
  })
  expect((await environment.resolveBaseEnvironment()).PATH).toBe('/usr/bin')
  mkdirSync(profileBin)
  const program = join(profileBin, process.platform === 'win32' ? `${name}.cmd` : name)
  writeFileSync(program, '#!/bin/sh\nexit 0\n')
  chmodSync(program, 0o755)
  profilePath = profileBin
  return { environment, program, profileBin }
}

function store(record: Partial<AgentSessionRecord>) {
  return {
    getRecord: () => ({ ...agentSessionRecordFixture(), providerHandleChain: [], ...record }),
    pinLaunchDirectory: vi.fn()
  }
}

describe('an agent installed after the first shell capture', () => {
  it("starts Claude's first chat, from the refreshed environment", async () => {
    const name = `claude-l5-${process.pid}`
    const host = await hostInstallingAfterFirstCapture(name)
    const sources = await resolveClaudeChildEnvSources({
      resolveInheritedEnv: host.environment.resolveBaseEnvironment,
      refreshEnvironmentAfterMiss: host.environment.refreshAfterMissingProgram,
      resolveCommand: (options) => resolveCliCommand(name, options)
    })
    expect(sources.command).toBe(host.program)
    expect(sources.inheritedEnv.PATH).toBe(host.profileBin)
  })

  it("starts Codex's first chat through the composed launch, from the refreshed environment", async () => {
    const name = `codex-l5-${process.pid}`
    const host = await hostInstallingAfterFirstCapture(name)
    const launch = await createCodexStructuredLaunchResolver({
      store: store({
        provider: 'codex',
        accountHome: { variable: 'CODEX_HOME', path: join(host.profileBin, '..', '.codex') }
      }),
      resolveEnvironment: host.environment.resolveBaseEnvironment,
      refreshAfterMissingProgram: host.environment.refreshAfterMissingProgram,
      resolveCommand: (options) => resolveCliCommand(name, options),
      resolveLaunchArgs: () => []
    })({ identity: { ...identity, agent: 'codex' } })
    expect(launch.command).toBe(host.program)
    expect(launch.env.PATH).toBe(host.profileBin)
  })

  it('starts a Command setting installed after the capture, rather than refusing it', async () => {
    const name = `grok-l5-${process.pid}`
    const host = await hostInstallingAfterFirstCapture(name)
    const launch = await createAcpStructuredLaunchResolver(GROK, {
      store: store({
        provider: 'grok',
        accountHome: { variable: 'GROK_HOME', path: join(host.profileBin, '..', '.grok') }
      }),
      readJournal: () => null,
      resolveEnvironment: host.environment.resolveBaseEnvironment,
      refreshAfterMissingProgram: host.environment.refreshAfterMissingProgram,
      resolveCommandSettings: () => ({ agentCmdOverrides: { grok: name } })
    })({ identity })
    expect(launch.command).toBe(host.program)
  })

  it('never refreshes for a program the snapshot already finds', async () => {
    const name = `codex-l5-found-${process.pid}`
    const host = await hostInstallingAfterFirstCapture(name)
    // Puts the install in the snapshot before the launch asks.
    await host.environment.refreshAfterMissingProgram()
    const refresh = vi.fn(async () => {})
    const launch = await createCodexStructuredLaunchResolver({
      store: store({
        provider: 'codex',
        accountHome: { variable: 'CODEX_HOME', path: join(host.profileBin, '..', '.codex') }
      }),
      resolveEnvironment: host.environment.resolveBaseEnvironment,
      refreshAfterMissingProgram: refresh,
      resolveCommand: (options) => resolveCliCommand(name, options),
      resolveLaunchArgs: () => []
    })({ identity: { ...identity, agent: 'codex' } })
    expect(launch.command).toBe(host.program)
    expect(refresh).not.toHaveBeenCalled()
  })
})
