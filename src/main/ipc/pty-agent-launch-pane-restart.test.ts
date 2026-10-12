import { describe, expect, it, vi } from 'vitest'
import { pendingAgentSessionOperationRow } from '../../shared/agent-session-operation-ledger'
import { withDurableRuntimeStore } from '../runtime/runtime-durable-store-fixture'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { SessionNotFoundError } from '../daemon/daemon-errors'
import { makePaneKey } from '../../shared/stable-pane-id'
import { registerPtyHandlers } from './pty/register-handlers'
import { setLocalPtyProvider } from './pty/provider/registry'

vi.mock('electron', () => import('./pty-ipc-mock-registry').then((m) => m.electronModuleMock()))
vi.mock('fs', () => import('./pty-ipc-mock-registry').then((m) => m.fsModuleMock()))
vi.mock('node-pty', () => import('./pty-ipc-mock-registry').then((m) => m.nodePtyModuleMock()))
vi.mock('node:child_process', async (importOriginal) =>
  (await import('./pty-ipc-mock-registry')).childProcessModuleMock(await importOriginal())
)
vi.mock('../opencode/hook-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.openCodeHookServiceModuleMock())
)
vi.mock('../mimo/hook-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.mimoHookServiceModuleMock())
)
vi.mock('../agent-hooks/server', () =>
  import('./pty-ipc-mock-registry').then((m) => m.agentHookServerModuleMock())
)
vi.mock('../pi/titlebar-extension-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.piTitlebarExtensionModuleMock())
)
vi.mock('../pwsh', () => import('./pty-ipc-mock-registry').then((m) => m.pwshModuleMock()))
vi.mock('../wsl', async (importOriginal) =>
  (await import('./pty-ipc-mock-registry')).wslModuleMock(await importOriginal())
)
vi.mock('../telemetry/client', () =>
  import('./pty-ipc-mock-registry').then((m) => m.telemetryClientModuleMock())
)
vi.mock('../telemetry/classify-error', () =>
  import('./pty-ipc-mock-registry').then((m) => m.classifyErrorModuleMock())
)
vi.mock('../cli/linux-terminal-orca-cli-shim', () =>
  import('./pty-ipc-mock-registry').then((m) => m.linuxCliShimModuleMock())
)
vi.mock('../memory/pty-registry', () =>
  import('./pty-ipc-mock-registry').then((m) => m.ptyRegistryModuleMock())
)
vi.mock('../agent-hooks/migration-unsupported-pty-state', () =>
  import('./pty-ipc-mock-registry').then((m) => m.migrationUnsupportedPtyModuleMock())
)
vi.mock('../codex/codex-pane-account-registry', () =>
  import('./pty-ipc-mock-registry').then((m) => m.codexPaneAccountRegistryModuleMock())
)
vi.mock('../codex/codex-state-db-backfill-recovery', () =>
  import('./pty-ipc-mock-registry').then((m) => m.codexBackfillRecoveryModuleMock())
)

/** The daemon's three answers for a restored pane's binding, as `attachStablePaneOwner` reads them. */
const DAEMON_ANSWERS = [
  ['live: the agent survived, so the pane reattaches to it', 'live'],
  ['exited: the pane opens a fresh shell, as any tab does', 'exited'],
  ['daemon gone: the terminal host is unavailable, as for any tab', 'gone']
] as const

describe('a launch pane after a restart', () => {
  const { handlers, mainWindow } = setupPtyIpcSuite()

  it.each(DAEMON_ANSWERS)(
    '%s; an unsettled launch row naming it is never read',
    async (_name, daemon) => {
      const worktreeId = 'repo-1::/tmp/launch-restart'
      const tabId = 'tab-launch-restart'
      const leafId = '89898989-8989-4989-8989-898989898989'
      const paneKey = makePaneKey(tabId, leafId)
      const providerSpawn = vi.fn(async (options: { attachOnly?: boolean }) => {
        if (!options.attachOnly) {
          return { id: 'pty-fresh-shell', incarnationId: 'inc-fresh' }
        }
        if (daemon === 'live') {
          return { id: 'pty-survived', incarnationId: 'inc-survived', isReattach: true }
        }
        throw daemon === 'exited'
          ? new SessionNotFoundError('pty-survived')
          : Object.assign(new Error('connect ECONNREFUSED'), {
              code: 'ECONNREFUSED',
              syscall: 'connect'
            })
      })
      setLocalPtyProvider({
        spawn: providerSpawn,
        write: vi.fn(),
        resize: vi.fn(),
        kill: vi.fn(),
        shutdown: vi.fn(),
        sendSignal: vi.fn(),
        getCwd: vi.fn(),
        getInitialCwd: vi.fn(),
        clearBuffer: vi.fn(),
        acknowledgeDataEvent: vi.fn(),
        hasChildProcesses: vi.fn(),
        getForegroundProcess: vi.fn(),
        serialize: vi.fn(),
        revive: vi.fn(),
        onData: vi.fn(() => () => {}),
        onReplay: vi.fn(() => () => {}),
        onExit: vi.fn(() => () => {}),
        listProcesses: vi.fn(async () => []),
        attach: vi.fn(),
        getDefaultShell: vi.fn(),
        getProfiles: vi.fn()
      } as never)
      // Written by a build before this one: the tab kept its launch pane and the row named it.
      let session = {
        tabsByWorktree: {
          [worktreeId]: [
            {
              id: tabId,
              worktreeId,
              ptyId: 'pty-survived',
              agentLaunchPane: { leafId, outcome: { kind: 'unconfirmed' } }
            }
          ]
        },
        terminalLayoutsByTabId: {
          [tabId]: {
            root: { type: 'leaf' as const, leafId },
            activeLeafId: leafId,
            expandedLeafId: null,
            ptyIdsByLeafId: { [leafId]: 'pty-survived' }
          }
        },
        terminalPtyIncarnationsByPaneKey: { [paneKey]: 'inc-survived' }
      }
      const unsettledRow = {
        ...pendingAgentSessionOperationRow({
          callerKey: 'caller',
          operationId: `${Date.now()}-${'1'.padStart(32, '0')}`,
          fingerprint: 'fp',
          now: Date.now()
        }),
        outcome: { status: 'unknown' as const },
        ownedPane: { worktreeId, paneKey }
      }
      const store = withDurableRuntimeStore({
        getWorkspaceSession: vi.fn(() => session),
        setWorkspaceSession: vi.fn((next) => {
          session = next
        }),
        flushOrThrow: vi.fn(),
        persistPtyBinding: vi.fn(),
        getFolderWorkspace: vi.fn(() => undefined),
        getFolderWorkspaces: vi.fn(() => []),
        getProjectGroups: vi.fn(() => []),
        getRepos: vi.fn(() => [])
      })
      const runtime = {
        setPtyController: vi.fn(),
        resolveTerminalPane: vi.fn(() => {
          throw new Error('terminal_not_found')
        }),
        createPreAllocatedTerminalHandle: vi.fn(() => 'term-restart'),
        preAllocateHandleForPty: vi.fn(() => 'term-restart'),
        registerPreAllocatedHandleForPty: vi.fn(),
        beginPtyRegistration: vi.fn(),
        cancelPendingPtyRegistration: vi.fn(),
        assertPtyRegistrationAllowed: vi.fn(),
        registerPty: vi.fn(),
        noteTerminalSpawnCommand: vi.fn(),
        seedHeadlessTerminal: vi.fn(),
        onPtySpawned: vi.fn(),
        onPtyExit: vi.fn(),
        onPtyData: vi.fn(),
        hasLiveTerminalForPaneKey: vi.fn(() => false),
        openedAgentSessionRecordStore: vi.fn(() => ({ listOperationRows: () => [unsettledRow] })),
        openAgentSessionRecordStore: vi.fn(async () => ({
          listOperationRows: () => [unsettledRow]
        })),
        reportAgentLaunchPaneVerdict: vi.fn()
      }
      registerPtyHandlers(
        mainWindow as never,
        runtime as never,
        undefined,
        undefined,
        undefined,
        store as never
      )

      const mounted = Promise.resolve(
        handlers.get('pty:spawn')!(null, {
          cols: 80,
          rows: 24,
          cwd: '/tmp/launch-restart',
          worktreeId,
          tabId,
          leafId,
          env: { ORCA_PANE_KEY: paneKey, ORCA_TAB_ID: tabId, ORCA_WORKTREE_ID: worktreeId }
        })
      )

      const ids = { live: 'pty-survived', exited: 'pty-fresh-shell' } as const
      await (daemon === 'gone'
        ? expect(mounted).rejects.toThrow('terminal_host_gone')
        : expect(mounted).resolves.toMatchObject({ id: ids[daemon] }))
      expect(runtime.openedAgentSessionRecordStore).not.toHaveBeenCalled()
      expect(runtime.openAgentSessionRecordStore).not.toHaveBeenCalled()
      expect(runtime.reportAgentLaunchPaneVerdict).not.toHaveBeenCalled()
    }
  )
})
