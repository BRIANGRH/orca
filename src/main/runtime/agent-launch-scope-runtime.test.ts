import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import { _resetWslCachesForTests, _setWslCachesForTests } from '../wsl'
import {
  agentLaunchPlatformForScope,
  resolveAgentLaunchRuntime
} from './agent-launch-scope-runtime'
import type { TerminalWorkspaceLaunchScope } from './runtime-legacy-worker-terminal-recovery-types'
import { agentLaunchQuotingShell } from '../../shared/agent-launch-runtime'

const WIN = 'C:\\repo'
const SHARE = '\\\\wsl$\\Ubuntu\\home\\a\\repo'
const UBUNTU = { kind: 'wsl', distro: 'Ubuntu' } as const
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the resolvers read only the fields each fixture sets.
const fixture = <T>(fields: Partial<T>): T => fields as T
const repo = (path: string) => fixture<Repo>({ id: 'r', path, projectGroupId: 'g' })
const folder = (path: string) =>
  fixture<FolderWorkspace>({ id: 'f', projectGroupId: 'g', folderPath: path })
const scope = (
  path: string,
  kind: { repo?: Repo; folder?: FolderWorkspace }
): TerminalWorkspaceLaunchScope => ({
  id: kind.repo ? 'r' : 'f',
  path,
  connectionId: null,
  repo: kind.repo ?? null,
  folderWorkspace: kind.folder ?? null
})
function store(args: {
  repos?: Repo[]
  /** Repo `r`'s project runtime. */
  project?: unknown
  global?: unknown
  folder?: FolderWorkspace
  shell?: string
}) {
  const fake = {
    getProjects: () => [
      { id: 'p', sourceRepoIds: ['r'], localWindowsRuntimePreference: args.project }
    ],
    getSettings: () => ({
      terminalWindowsShell: args.shell ?? 'cmd.exe',
      localWindowsRuntimeDefault: args.global
    }),
    getRepo: (id: string) => (id === 'r' ? repo(WIN) : undefined),
    getRepos: () => args.repos ?? [],
    getFolderWorkspaces: () => (args.folder ? [args.folder] : []),
    getProjectGroups: () => [{ id: 'g', name: 'g', parentPath: null, connectionId: null }]
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the resolvers read only these members and fields.
  return fake as never
}

const original = process.platform
beforeEach(() =>
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: 'win32'
  })
)
afterEach(() => {
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: original
  })
  _resetWslCachesForTests()
})

// Relied on by C2: "+" moves onto the host planner with no change, because both sides use this rule.
describe("the window's runtime rule, on the host", () => {
  it.each([
    ['repo, project WSL', store({ project: UBUNTU }), scope(WIN, { repo: repo(WIN) }), 'linux'],
    [
      'repo whose project follows a WSL global default',
      store({ global: UBUNTU }),
      scope(WIN, { repo: repo(WIN) }),
      'linux'
    ],
    [
      'folder holding one WSL-project repo',
      store({
        project: UBUNTU,
        repos: [repo(WIN)],
        folder: folder('C:\\work')
      }),
      scope('C:\\work', { folder: folder('C:\\work') }),
      'linux'
    ],
    [
      'repo-less folder ignores the global default, as the window does',
      store({ global: UBUNTU, folder: folder('C:\\work') }),
      scope('C:\\work', { folder: folder('C:\\work') }),
      'win32'
    ]
  ])('%s', (_name, s, launchScope, platform) => {
    expect(agentLaunchPlatformForScope(s, launchScope)).toBe(platform)
  })
})

// PLAN §7 UNVERIFIED 4. Relied on by C2, whose pane spawn takes the host's answer.
it("answers from main's WSL cache, which the window may not have read yet", () => {
  _setWslCachesForTests({ available: true, distros: ['Debian'] })
  expect(() =>
    resolveAgentLaunchRuntime(
      store({ project: UBUNTU }),
      scope(WIN, { repo: repo(WIN) }),
      undefined
    )
  ).toThrow('wsl-distro-missing')
  // A `\\wsl$` path proves its distro, so a stale cache never refuses it.
  expect(
    resolveAgentLaunchRuntime(store({}), scope(SHARE, { repo: repo(SHARE) }), undefined).platform
  ).toBe('linux')
  // A repo-less `\\wsl$` folder has no runtime to repair, as in the window: its path places it.
  expect(
    resolveAgentLaunchRuntime(store({}), scope(SHARE, { folder: folder(SHARE) }), undefined)
      .platform
  ).toBe('linux')
})

// Relied on by C2: the pane's pty:spawn takes the fact as is, for quoting and shell alike.
it('quotes for the shell the PTY gets, not a setting the runtime replaced', () => {
  const windowsHost = store({ project: { kind: 'windows-host' }, shell: 'wsl.exe' })
  const local = resolveAgentLaunchRuntime(windowsHost, scope(WIN, { repo: repo(WIN) }), undefined)
  expect(local.pty.shellOverride).toBe('powershell.exe')
  expect(agentLaunchQuotingShell(local)).toBe('powershell')
})

// TEMPORARY until STA-10231. Only folders reach it: every local repo has a project runtime.
it.each([['follows the global default'], ['is set to Windows host', { kind: 'windows-host' }]])(
  "keeps a folder's WSL Terminal shell where its repo's project %s",
  (_name, project?: unknown) => {
    const legacy = resolveAgentLaunchRuntime(
      store({
        project,
        global: { kind: 'windows-host' },
        shell: 'wsl.exe',
        repos: [repo(WIN)],
        folder: folder('C:\\work')
      }),
      scope('C:\\work', { folder: folder('C:\\work') }),
      undefined
    )
    expect([legacy.platform, legacy.pty.shellOverride, agentLaunchQuotingShell(legacy)]).toEqual([
      'win32',
      'wsl.exe',
      'posix'
    ])
  }
)

// TEMPORARY until OpenCode models are verified inside WSL: a model pick runs where main ran it.
it('keeps an OpenCode model pick in a WSL folder on Windows, as main ran it', () => {
  const wslFolder = store({ project: UBUNTU, repos: [repo(WIN)], folder: folder('C:\\work') })
  const platform = (openCodeModelPick: boolean) =>
    resolveAgentLaunchRuntime(
      wslFolder,
      scope('C:\\work', { folder: folder('C:\\work') }),
      undefined,
      openCodeModelPick
    ).platform
  expect([platform(true), platform(false)]).toEqual(['win32', 'linux'])
})
