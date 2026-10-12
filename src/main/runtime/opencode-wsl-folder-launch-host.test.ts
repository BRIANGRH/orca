import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'

vi.mock('../opencode/opencode-launch-capabilities', () => ({
  probeOpenCodeLaunchCapabilities: async () => ({
    version: '1.18.30',
    pluginApi: 'v1',
    promptMode: 'submit'
  })
}))
vi.mock('../opencode/opencode-model-availability', () => ({
  probeOpenCodeModelAvailability: async () => true,
  resolveOpenCodeDirectModelExecutable: async () => 'opencode'
}))

const repo = { id: 'r', path: 'C:\\repo', kind: 'git', projectGroupId: 'g' }
const folder = { id: 'f', projectGroupId: 'g', folderPath: 'C:\\work' }
const wsl = { kind: 'wsl', distro: 'Ubuntu' }
const store = {
  // A WSL Terminal shell must not move the model check into WSL, as it did once.
  getSettings: () => ({
    disabledTuiAgents: [],
    terminalWindowsShell: 'wsl.exe',
    terminalWindowsWslDistro: 'Ubuntu'
  }),
  getProjects: () => [{ id: 'p', sourceRepoIds: ['r'], localWindowsRuntimePreference: wsl }],
  getRepo: (id: string) => (id === 'r' ? repo : undefined),
  getRepos: () => [repo],
  getFolderWorkspaces: () => [folder],
  getProjectGroups: () => [{ id: 'g' }]
}
const scope = { id: 'f', path: 'C:\\work', connectionId: null, repo: null, folderWorkspace: folder }
let runtime: OrcaRuntimeService
let spawned: () => (string | undefined)[]
const original = process.platform
const setPlatform = (value: string) =>
  Object.defineProperty(process, 'platform', { configurable: true, value })
beforeEach(() => {
  setPlatform('win32')
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these paths read only the members above.
  runtime = new OrcaRuntimeService(store as never)
  Object.assign(runtime, {
    resolveTerminalWorkspaceLaunchScope: async () => scope,
    executionOwnerSupportsAgentSessionOperation: async () => true
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: callers read only the handle.
  const create = vi.spyOn(runtime, 'createTerminal').mockResolvedValue({ handle: 't' } as never)
  spawned = () => create.mock.calls.map(([, opts]) => opts?.launchRuntime?.platform)
})
afterEach(() => setPlatform(original))

// TEMPORARY until STA-10251: in a folder whose repo runs in WSL, OpenCode keeps main's Windows
// runtime at every entry point, so they agree.
it('creates an OpenCode session in a WSL folder on Windows', async () => {
  const clientOperationId = `${Date.now()}-0123456789abcdef0123456789abcdef`
  await runtime.createAgentSession({ clientOperationId, worktree: 'id:f', agent: 'opencode' })
  expect(spawned()).toEqual(['win32'])
})
it('resumes an OpenCode session in a WSL folder on Windows', async () => {
  const providerSession = { key: 'session_id', id: 'ses_1' } as const
  await runtime.ensureAgentSession({
    kind: 'explicit',
    worktree: 'id:f',
    agent: 'opencode',
    providerSession
  })
  expect(spawned()).toEqual(['win32'])
})
it('checks an OpenCode model in a WSL folder on Windows, where it launches', async () => {
  const target = { worktree: 'id:f', model: 'm' }
  expect(await runtime.probeOrchestrationOpenCodeModelLaunchSupport(target)).toBe(true)
})
