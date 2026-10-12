/**
 * WSL-via-orcad C7 with a fake WSL transport: no wsl.exe in CI. The HUB fixture stands in for the
 * distro's orcad; a second desktop, launched with ORCA_E2E_FAKE_WSL_HOSTS, adds that "distro" as a
 * host through the real add-host UI, adds a project on it, and runs a terminal there.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  _electron as electron,
  type ElectronApplication,
  type Page
} from '@stablyai/playwright-test'
import { getE2ECompletedOnboardingProfile } from './helpers/e2e-completed-onboarding-profile'
import { getOrcaElectronLaunchArgs } from './helpers/electron-launch-args'
import { cleanupE2EDaemons, closeElectronAppForE2E } from './helpers/electron-process-shutdown'
import { createElectronHomeIsolation } from './helpers/electron-home-isolation'
import { expect, forwardElectronProcessLogs, test } from './helpers/orca-app'
import { createRuntimeDesktopPairingOffer } from './helpers/paired-electron-client'
import { openSidebarProjectDialog } from './helpers/sidebar-project-dialog'
import { ensureTerminalVisible, waitForSessionReady } from './helpers/store'
import {
  focusActiveTerminalInput,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from './helpers/terminal'

const WSL_ENVIRONMENT_ID = 'wsl:ubuntu'
const WSL_HOST_LABEL = 'Ubuntu (WSL)'
const UBUNTU_DISTRO = { name: 'Ubuntu', state: 'running', version: 2 }
const LEGACY_DISTRO = { name: 'Legacy', state: 'stopped', version: 1 }

async function launchDesktopWithFakeWsl(
  pairingCode: string,
  testInfo: Parameters<typeof forwardElectronProcessLogs>[1],
  fakeOverrides: Record<string, unknown> = {}
): Promise<{ app: ElectronApplication; page: Page; dispose: () => Promise<void> }> {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-wsl-desktop-'))
  writeFileSync(
    path.join(userDataDir, 'orca-data.json'),
    `${JSON.stringify(getE2ECompletedOnboardingProfile(), null, 2)}\n`
  )
  const { ELECTRON_RUN_AS_NODE: _unused, ...cleanEnv } = process.env
  void _unused
  const isolation = createElectronHomeIsolation({
    inheritedEnv: cleanEnv,
    launchEnv: {},
    extraEnv: {
      ORCA_E2E_FAKE_WSL_HOSTS: JSON.stringify({
        distros: [
          { name: 'Ubuntu', state: 'running', version: 2 },
          { name: 'Legacy', state: 'stopped', version: 1 }
        ],
        pairingCode,
        ...fakeOverrides
      })
    },
    userDataDir
  })
  const app = await electron.launch({
    args: getOrcaElectronLaunchArgs(path.join(process.cwd(), 'out', 'main', 'index.js'), false),
    env: { ...isolation.env, NODE_ENV: 'development', ORCA_E2E_HEADLESS: '1' }
  })
  forwardElectronProcessLogs(app, testInfo)
  const dispose = async (): Promise<void> => {
    await closeElectronAppForE2E(app)
    await cleanupE2EDaemons(userDataDir)
    rmSync(userDataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
  try {
    const page = await app.firstWindow({ timeout: 120_000 })
    await page.waitForLoadState('domcontentloaded')
    await waitForSessionReady(page)
    return { app, page, dispose }
  } catch (error) {
    await dispose()
    throw error
  }
}

async function setWslHostsEnabled(page: Page, enabled: boolean): Promise<void> {
  await page.evaluate(async (experimentalWslHosts) => {
    const settings = await window.api.settings.set({ experimentalWslHosts })
    window.__store?.setState({ settings })
  }, enabled)
}

async function settleAnimations(page: Page): Promise<void> {
  // Why finite only: spinners and pulses run forever; the dialog and popover fades do not.
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .every(
        (animation) =>
          animation.playState !== 'running' ||
          animation.effect?.getComputedTiming().iterations === Infinity
      )
  )
}

function createGitProject(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-wsl-project-'))
  execFileSync('git', ['init', '-q', '-b', 'main', dir])
  writeFileSync(path.join(dir, 'README.md'), '# wsl host project\n')
  execFileSync('git', ['-C', dir, 'add', '.'])
  execFileSync(
    'git',
    ['-C', dir, '-c', 'user.name=e2e', '-c', 'user.email=e2e@example.com', 'commit', '-qm', 'init'],
    { stdio: 'ignore' }
  )
  return dir
}

test('adds a WSL distro as a host, adds a project on it, and runs a terminal there', async ({
  orcaPage
}, testInfo) => {
  test.setTimeout(240_000)
  await waitForSessionReady(orcaPage)
  const offer = await createRuntimeDesktopPairingOffer(orcaPage)
  // Starts with only a WSL 1 distro; Ubuntu is "imported" while the add dialog is open.
  const distrosDir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-wsl-distros-'))
  const distrosFile = path.join(distrosDir, 'distros.json')
  writeFileSync(distrosFile, JSON.stringify([LEGACY_DISTRO]))
  const desktop = await launchDesktopWithFakeWsl(offer.pairingUrl, testInfo, { distrosFile })
  const projectPath = createGitProject()
  try {
    const { page } = desktop
    await setWslHostsEnabled(page, true)

    await openSidebarProjectDialog(page)
    const addProject = page.getByRole('dialog', { name: /Add a project/i })
    await addProject.getByRole('combobox').click()
    await page.locator('[cmdk-item]').filter({ hasText: 'Add remote host' }).click()
    await page.getByRole('button', { name: /Add WSL distro/ }).click()

    const addHost = page.getByRole('dialog', { name: 'Add WSL distro' })
    await expect(addHost).toBeVisible()
    await expect(addHost.getByRole('combobox')).toContainText('Choose a distro')
    writeFileSync(distrosFile, JSON.stringify([UBUNTU_DISTRO, LEGACY_DISTRO]))
    await addHost.getByRole('button', { name: 'Refresh' }).click()
    // Only Ubuntu can be added (Legacy is WSL 1), so it is preselected.
    await expect(addHost.getByRole('combobox')).toContainText('Ubuntu')
    await settleAnimations(page)
    await page.screenshot({ path: testInfo.outputPath('wsl-add-host-dialog.png') })

    await addHost.getByRole('button', { name: 'Add host' }).click()
    await expect(addHost).toBeHidden({ timeout: 60_000 })
    await expect
      .poll(
        () =>
          page.evaluate(
            (environmentId) =>
              window.__store
                ?.getState()
                .runtimeEnvironments.find((environment) => environment.id === environmentId)
                ?.orcadDeployment?.kind ?? null,
            WSL_ENVIRONMENT_ID
          ),
        { timeout: 30_000 }
      )
      .toBe('wsl')

    // The add-project dialog stays open under the add-host dialog, as it does for SSH hosts.
    const picker = addProject.getByRole('combobox')
    await picker.click()
    const hostRow = page.locator('[cmdk-item]').filter({ hasText: WSL_HOST_LABEL })
    await expect(hostRow).toContainText('WSL distro', { timeout: 60_000 })
    await expect(hostRow).toContainText('Connected', { timeout: 60_000 })
    await settleAnimations(page)
    await page.screenshot({ path: testInfo.outputPath('wsl-host-row.png') })
    await hostRow.click()
    await expect(picker).toContainText(WSL_HOST_LABEL)

    const dialog = page.getByRole('dialog', { name: /Add a project/i })
    await dialog.getByRole('button', { name: /Browse folder|Browse host/i }).click()
    const browse = page.getByRole('dialog', { name: /Browse host filesystem/i })
    await expect(browse).toBeVisible()
    await browse.getByRole('button', { name: /^Cancel$/i }).click()
    const manual = page.getByRole('dialog', { name: /Open host project/i })
    await manual.locator('#server-project-path').fill(projectPath)
    await manual.getByRole('button', { name: /Add Git Project/i }).click()
    await expect(manual).toBeHidden({ timeout: 60_000 })

    await expect
      .poll(
        () =>
          page.evaluate(
            (repoPath) =>
              window.__store?.getState().repos.find((repo) => repo.path === repoPath)
                ?.executionHostId ?? null,
            projectPath
          ),
        { timeout: 60_000 }
      )
      .toBe(`runtime:${encodeURIComponent(WSL_ENVIRONMENT_ID)}`)

    // Matched by repo: the worktree path may be reported under its realpath (/private/var on macOS).
    await expect
      .poll(
        () =>
          page.evaluate(
            ({ repoPath, environmentId }) => {
              const state = window.__store?.getState()
              const repo = state?.repos.find((entry) => entry.path === repoPath)
              const worktree = repo
                ? state?.allWorktrees().find((entry) => entry.repoId === repo.id)
                : undefined
              if (!state || !worktree) {
                return false
              }
              state.setActiveWorktree(worktree.id, `runtime:${encodeURIComponent(environmentId)}`)
              return true
            },
            { repoPath: projectPath, environmentId: WSL_ENVIRONMENT_ID }
          ),
        { timeout: 60_000 }
      )
      .toBe(true)
    await ensureTerminalVisible(page, 30_000)
    await waitForActiveTerminalManager(page, 30_000)
    const ptyId = await waitForActivePanePtyId(page, 30_000)
    expect(ptyId).toMatch(/^remote:/)
    await focusActiveTerminalInput(page)
    await page.keyboard.type("printf 'WSL_HOST_TERMINAL_%s\\n' ready")
    await page.keyboard.press('Enter')
    await waitForTerminalOutput(page, 'WSL_HOST_TERMINAL_ready', 30_000)
    await page.screenshot({ path: testInfo.outputPath('wsl-host-terminal.png') })

    // Experiment off: the host stays listed so its projects never seem to vanish, but turned off.
    await setWslHostsEnabled(page, false)
    await openSidebarProjectDialog(page)
    await page
      .getByRole('dialog', { name: /Add a project/i })
      .getByRole('combobox')
      .click()
    const offRow = page.locator('[cmdk-item]').filter({ hasText: WSL_HOST_LABEL })
    await expect(offRow).toContainText('Turned off in Settings → Experimental')
    await expect(offRow.getByRole('button', { name: 'Turn on' })).toBeVisible()
    await expect(offRow.getByRole('button', { name: 'Connect' })).toHaveCount(0)
    await settleAnimations(page)
    await page.screenshot({ path: testInfo.outputPath('wsl-host-row-turned-off.png') })
    await page.keyboard.press('Escape')
    const addProjectAgain = page.getByRole('dialog', { name: /Add a project/i })
    await expect(offRow).toBeHidden()
    await page.keyboard.press('Escape')
    await expect(addProjectAgain).toBeHidden()

    await page.evaluate(() => {
      const state = window.__store?.getState()
      state?.openSettingsPage()
      state?.openSettingsTarget({ pane: 'servers', repoId: null })
    })
    const section = page.locator('[data-settings-section="wsl-hosts"]')
    await section.scrollIntoViewIfNeeded()
    await expect(section).toContainText('WSL hosts are turned off in Settings → Experimental')
    await expect(section.getByRole('button', { name: 'Connect' })).toBeDisabled()
    await settleAnimations(page)
    await section.screenshot({ path: testInfo.outputPath('wsl-hosts-settings-turned-off.png') })

    // Remove asks first, with WSL-specific copy, then drops the host.
    await setWslHostsEnabled(page, true)
    await section.getByRole('button', { name: 'Remove' }).click()
    const confirm = page.getByRole('dialog', { name: `Remove ${WSL_HOST_LABEL}?` })
    await expect(confirm).toContainText('stops Orca’s server in that distro')
    await expect(confirm).toContainText('Files in the distro are untouched.')
    await settleAnimations(page)
    await page.screenshot({ path: testInfo.outputPath('wsl-host-remove-confirm.png') })
    await confirm.getByRole('button', { name: 'Remove host' }).click()
    await expect(confirm).toBeHidden({ timeout: 30_000 })
    await expect
      .poll(() =>
        page.evaluate(
          (environmentId) =>
            window.__store
              ?.getState()
              .runtimeEnvironments.some((environment) => environment.id === environmentId) ?? true,
          WSL_ENVIRONMENT_ID
        )
      )
      .toBe(false)
  } finally {
    await desktop.dispose()
    rmSync(projectPath, { recursive: true, force: true })
    rmSync(distrosDir, { recursive: true, force: true })
  }
})

test('a build without the WSL host server files says so instead of failing an add', async ({
  orcaPage
}, testInfo) => {
  test.setTimeout(180_000)
  await waitForSessionReady(orcaPage)
  const offer = await createRuntimeDesktopPairingOffer(orcaPage)
  const desktop = await launchDesktopWithFakeWsl(offer.pairingUrl, testInfo, {
    serverFiles: 'missing'
  })
  try {
    const { page } = desktop
    await setWslHostsEnabled(page, true)
    await openSidebarProjectDialog(page)
    await page
      .getByRole('dialog', { name: /Add a project/i })
      .getByRole('combobox')
      .click()
    await page.locator('[cmdk-item]').filter({ hasText: 'Add remote host' }).click()
    await page.getByRole('button', { name: /Add WSL distro/ }).click()
    const addHost = page.getByRole('dialog', { name: 'Add WSL distro' })
    await expect(addHost.getByRole('alert')).toHaveText(
      'This build of Orca can’t run WSL hosts (server files missing).'
    )
    await expect(addHost.getByRole('button', { name: 'Add host' })).toBeDisabled()
    await expect(addHost.getByRole('combobox')).toBeDisabled()
    // Main refuses too, before any deploy work.
    expect(
      await page.evaluate(() => window.api.runtimeEnvironments.wslHosts?.add({ distro: 'Ubuntu' }))
    ).toMatchObject({ ok: false, kind: 'server-files-missing' })
    await settleAnimations(page)
    await page.screenshot({ path: testInfo.outputPath('wsl-add-host-server-files-missing.png') })
  } finally {
    await desktop.dispose()
  }
})
