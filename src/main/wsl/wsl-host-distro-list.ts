/**
 * The distros "Add WSL distro as a host" offers: every registered one (from the Lxss registry key,
 * which also says WSL 1 vs 2 without a localized `wsl --list --verbose` parse), with whether it
 * is running from a probe that never boots one. Docker Desktop's internal distros are not hosts.
 */
import type { WslHostDistro } from '../../shared/wsl-host-types'
import { filterUserWslDistros } from '../wsl-distro-list-output'
import { listConfirmedRunningWslDistros } from '../wsl-background-distro-gate'
import { defaultRegQuery, LXSS_KEY, type RegQuery } from './wsl-distro-registry-id'

export type WslRegisteredDistro = {
  /** The registration GUID, lowercase and unbraced (the deployment record's `distroId`). */
  id: string
  name: string
  version: 1 | 2 | null
}

const GUID_KEY = /\\\{([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\}\s*$/i
const VALUE_LINE = /^\s+(\S+)\s+REG_\w+\s+(.*?)\s*$/

/** Parses `reg query <Lxss> /s`; matched by shape, since the footer is localized. */
export function parseWslDistroRegistry(output: string): WslRegisteredDistro[] {
  const distros: WslRegisteredDistro[] = []
  let current: { id: string; name: string | null; version: 1 | 2 | null } | null = null
  const flush = (): void => {
    if (current?.name) {
      distros.push({ id: current.id, name: current.name, version: current.version })
    }
  }
  for (const line of output.split(/\r?\n/)) {
    if (/^HKEY_/i.test(line)) {
      flush()
      const key = GUID_KEY.exec(line)
      current = key?.[1] ? { id: key[1].toLowerCase(), name: null, version: null } : null
      continue
    }
    const value = VALUE_LINE.exec(line)
    if (!current || !value) {
      continue
    }
    if (value[1] === 'DistributionName') {
      current.name = value[2]
    } else if (value[1] === 'Version') {
      const version = Number.parseInt(value[2], 16)
      current.version = version === 1 || version === 2 ? version : null
    }
  }
  flush()
  return distros
}

export type WslHostDistroListDependencies = {
  query?: RegQuery
  listRunning?: () => Promise<string[]>
}

export type WslHostDistroCandidate = Omit<WslHostDistro, 'environmentId'> & { id: string }

export async function listWslHostDistros(
  dependencies: WslHostDistroListDependencies = {}
): Promise<WslHostDistroCandidate[]> {
  const [registry, running] = await Promise.all([
    (dependencies.query ?? defaultRegQuery)(['query', LXSS_KEY, '/s']).catch(() => null),
    (dependencies.listRunning ?? listConfirmedRunningWslDistros)()
  ])
  if (!registry || registry.code !== 0) {
    return []
  }
  const runningKeys = new Set(running.map((name) => name.trim().toLowerCase()))
  const registered = parseWslDistroRegistry(registry.stdout)
  const userNames = new Set(filterUserWslDistros(registered.map((distro) => distro.name)))
  return registered
    .filter((distro) => userNames.has(distro.name))
    .map((distro) => ({
      ...distro,
      state: runningKeys.has(distro.name.toLowerCase())
        ? ('running' as const)
        : ('stopped' as const)
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}
