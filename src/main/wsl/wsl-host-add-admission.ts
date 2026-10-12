/** Why a distro cannot be added as a WSL host, decided before anything runs in it. */
import type { WslHostAddResult } from '../../shared/wsl-host-types'
import type { WslHostDistroCandidate } from './wsl-host-distro-list'
import { wslDistroHolderKey } from './wsl-distro-holder-record'

export const WSL_HOSTS_DISABLED_MESSAGE = 'WSL hosts are turned off in Settings → Experimental.'

type WslHostAddRefusal = Extract<WslHostAddResult, { ok: false }>

export function sameWslDistro(left: string, right: string): boolean {
  return wslDistroHolderKey(left) === wslDistroHolderKey(right)
}

/** The candidate to add, or why not; a stopped distro needs the user's explicit start. */
export function admitWslHostDistro(args: {
  requested: string
  candidates: readonly WslHostDistroCandidate[]
  alreadyAdded: (distro: string) => boolean
  startIfStopped: boolean
}): { distro: WslHostDistroCandidate } | WslHostAddRefusal {
  const distro = args.candidates.find((candidate) => sameWslDistro(candidate.name, args.requested))
  if (!distro) {
    return {
      ok: false,
      kind: 'failed',
      message: `${args.requested} is not a registered WSL distro.`
    }
  }
  if (distro.version === 1) {
    return {
      ok: false,
      kind: 'unsupported-wsl1',
      message: `${distro.name} runs WSL 1, which isn’t supported as a host. Convert it with: wsl --set-version ${distro.name} 2`
    }
  }
  if (args.alreadyAdded(distro.name)) {
    return { ok: false, kind: 'already-added', message: `${distro.name} is already a host.` }
  }
  if (distro.state === 'stopped' && !args.startIfStopped) {
    return {
      ok: false,
      kind: 'distro-stopped',
      message: `${distro.name} is stopped. Start it to add it as a host.`
    }
  }
  return { distro }
}
