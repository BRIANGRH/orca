import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import { resolveProjectExecutionRuntime } from '../../shared/project-execution-runtime'
import { _resetWslCachesForTests, _setWslCachesForTests } from '../wsl'
import {
  agentLaunchPlatformForScope,
  resolveAgentLaunchRuntime
} from './agent-launch-scope-runtime'
import type { TerminalWorkspaceLaunchScope } from './runtime-legacy-worker-terminal-recovery-types'

const WIN = 'C:\\repo'
const SHARE = '\\\\wsl$\\Ubuntu\\home\\a\\repo'
const UBUNTU = { kind: 'wsl', distro: 'Ubuntu' } as const
const repo = (path: string): Repo => ({
  id: 'r',
  path,
  displayName: 'r',
  badgeColor: '#000',
  addedAt: 0,
  projectGroupId: 'g'
})
const folder = (path: string): FolderWorkspace => ({
  id: 'f',
  projectGroupId: 'g',
  name: 'f',
  folderPath: path,
  linkedTask: null,
  comment: '',
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 0,
  createdAt: 0,
  updatedAt: 0
})
const scope = (
  path: string,
  kind: { repo?: Repo; folder?: FolderWorkspace }
): TerminalWorkspaceLaunchScope => ({
  id: 'w',
  path,
  connectionId: null,
  repo: kind.repo ?? null,
  folderWorkspace: kind.folder ?? null
})
function store(args: {
  repos?: Repo[]
  project?: unknown
  global?: unknown
  folder?: FolderWorkspace
}) {
  const fake = {
    getProjects: () => [
      {
        id: 'p',
        sourceRepoIds: ['r'],
        localWindowsRuntimePreference: args.project
      }
    ],
    getSettings: () => ({
      terminalWindowsShell: 'cmd.exe',
      localWindowsRuntimeDefault: args.global
    }),
    getRepo: () => args.repos?.[0],
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
      'repo, no saved runtime, \\\\wsl$ path',
      store({}),
      scope(SHARE, { repo: repo(SHARE) }),
      'linux'
    ],
    [
      'repo, global default WSL',
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
    ],
    ['repo-less \\\\wsl$ folder', store({}), scope(SHARE, { folder: folder(SHARE) }), 'linux']
  ])('%s', (_name, s, launchScope, platform) => {
    expect(agentLaunchPlatformForScope(s, launchScope)).toBe(platform)
  })
})

// PLAN §7 UNVERIFIED 4. Relied on by C2, whose pane spawn takes the host's answer.
it("answers from main's WSL cache when the window has not loaded its own", () => {
  _setWslCachesForTests({ available: true, distros: ['Debian'] })
  expect(() =>
    resolveAgentLaunchRuntime(
      store({ project: UBUNTU }),
      scope(WIN, { repo: repo(WIN) }),
      undefined
    )
  ).toThrow('wsl-distro-missing')
  // The window before its first capability read passes no WSL facts (local-preflight-context.ts).
  expect(
    resolveProjectExecutionRuntime({
      appPlatform: 'win32',
      projectId: 'p',
      projectRuntimePreference: UBUNTU
    }).status
  ).toBe('resolved')
})
