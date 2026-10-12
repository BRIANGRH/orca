/**
 * Which paired runtime environments are a WSL distro's orcad, so desktop-side shims (accounts)
 * know the distro behind an environment id. Fed by `WslOrcadConnectionManager`: an environment is
 * listed only while its connection is open.
 */
const distrosByEnvironment = new Map<string, string>()

export function registerWslOrcadHostEnvironment(environmentId: string, distro: string): void {
  distrosByEnvironment.set(environmentId, distro)
}

export function unregisterWslOrcadHostEnvironment(environmentId: string, distro: string): void {
  if (distrosByEnvironment.get(environmentId) === distro) {
    distrosByEnvironment.delete(environmentId)
  }
}

export function wslOrcadHostDistro(environmentId: string): string | null {
  return distrosByEnvironment.get(environmentId) ?? null
}
