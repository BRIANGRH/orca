import { describe, expect, it } from 'vitest'
import { listWslHostDistros, parseWslDistroRegistry } from './wsl-host-distro-list'

const LXSS = 'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss'
const REGISTRY = [
  LXSS,
  '    DefaultDistribution    REG_SZ    {0e3a7f2c-1b4d-4c5e-9f60-7a8b9c0d1e2f}',
  '',
  `${LXSS}\\{0E3A7F2C-1B4D-4C5E-9F60-7A8B9C0D1E2F}`,
  '    State    REG_DWORD    0x1',
  '    DistributionName    REG_SZ    Ubuntu',
  '    Version    REG_DWORD    0x2',
  '',
  `${LXSS}\\{11111111-2222-4333-8444-555555555555}`,
  '    DistributionName    REG_SZ    Legacy',
  '    Version    REG_DWORD    0x1',
  '',
  `${LXSS}\\{99999999-2222-4333-8444-555555555555}`,
  '    DistributionName    REG_SZ    docker-desktop-data',
  '    Version    REG_DWORD    0x2',
  '',
  `${LXSS}\\{aaaaaaaa-2222-4333-8444-555555555555}`,
  '    DistributionName    REG_SZ    Debian',
  '    Version    REG_DWORD    0x2',
  '',
  'The operation completed successfully.'
].join('\r\n')

describe('WSL host distro list', () => {
  it('reads each registration’s name, version and unbraced lowercase GUID', () => {
    expect(parseWslDistroRegistry(REGISTRY)).toEqual([
      { id: '0e3a7f2c-1b4d-4c5e-9f60-7a8b9c0d1e2f', name: 'Ubuntu', version: 2 },
      { id: '11111111-2222-4333-8444-555555555555', name: 'Legacy', version: 1 },
      { id: '99999999-2222-4333-8444-555555555555', name: 'docker-desktop-data', version: 2 },
      { id: 'aaaaaaaa-2222-4333-8444-555555555555', name: 'Debian', version: 2 }
    ])
  })

  it('drops Docker Desktop’s distros and marks running ones from the no-boot probe', async () => {
    const distros = await listWslHostDistros({
      query: async () => ({ code: 0, stdout: REGISTRY }),
      listRunning: async () => ['ubuntu']
    })
    expect(distros.map(({ name, state, version }) => ({ name, state, version }))).toEqual([
      { name: 'Debian', state: 'stopped', version: 2 },
      { name: 'Legacy', state: 'stopped', version: 1 },
      { name: 'Ubuntu', state: 'running', version: 2 }
    ])
  })

  it('lists nothing when the registry cannot be read', async () => {
    await expect(
      listWslHostDistros({
        query: async () => ({ code: 1, stdout: '' }),
        listRunning: async () => []
      })
    ).resolves.toEqual([])
  })
})
