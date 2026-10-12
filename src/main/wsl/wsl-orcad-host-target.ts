/**
 * The identity a WSL distro's orcad transport reports. `kind` is absent from `SshTarget`, which is
 * what tells the two apart; `distro` matches the persisted WSL deployment record's.
 */
export type WslOrcadHostTarget = {
  kind: 'wsl'
  id: string
  distro: string
  label: string
}

export function wslOrcadHostTarget(distro: string): WslOrcadHostTarget {
  return { kind: 'wsl', id: `wsl:${distro}`, distro, label: distro }
}
