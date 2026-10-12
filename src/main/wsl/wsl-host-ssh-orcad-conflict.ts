/**
 * R25: one distro reached both as an SSH target (an SSH server inside WSL, e.g. 127.0.0.1:2222)
 * and as a WSL host would give one orcad install (`~/.orca-remote`, activation journal, locks)
 * two desktop-side owners. Until conversion exists, adding the WSL host is refused.
 *
 * Evidence: orcad's pairing identity is the E2EE key in its data dir (`~/.orca`), the same key
 * every pairing with it carries. A server this desktop already pairs with (SSH-managed or paired
 * by hand) whose key matches is the distro's orcad. Limits: an orcad another desktop deployed is
 * not ours to see (C4's activation admission still guards it), and a data dir moved off
 * `~/.orca` is not checked.
 */
import { E2EE_KEYPAIR_FILENAME } from '../../shared/runtime-e2ee-keypair-file'
import {
  getPreferredPairingOffer,
  type KnownRuntimeEnvironment
} from '../../shared/runtime-environments'
import type { OrcadHostTransport } from '../ssh/orcad-host-transport'
import { execCommand } from '../ssh/ssh-relay-exec-command'

// Prints only the public half; the private key never leaves the distro.
const READ_PUBLIC_KEY = `sed -n 's/.*"publicKeyB64"[[:space:]]*:[[:space:]]*"\\([A-Za-z0-9+/=]*\\)".*/\\1/p' "$HOME/.orca/${E2EE_KEYPAIR_FILENAME}" 2>/dev/null | head -n 1`

export async function readWslDistroOrcadPublicKey(
  transport: OrcadHostTransport,
  signal?: AbortSignal
): Promise<string | null> {
  const key = (await execCommand(transport, READ_PUBLIC_KEY, { signal })).trim()
  return /^[A-Za-z0-9+/]+={0,2}$/.test(key) ? key : null
}

/** A non-WSL server this desktop pairs with that is the distro's own orcad, if any. */
export function findServerSharingWslOrcad(
  environments: readonly KnownRuntimeEnvironment[],
  distroPublicKeyB64: string | null
): KnownRuntimeEnvironment | null {
  if (!distroPublicKeyB64) {
    return null
  }
  return (
    environments.find(
      (environment) =>
        environment.orcadDeployment?.kind !== 'wsl' &&
        getPreferredPairingOffer(environment).publicKeyB64 === distroPublicKeyB64
    ) ?? null
  )
}
