/**
 * Inside a WSL distro (orcad on a WSL host), WSL appends the Windows PATH to the guest's, so a bare
 * PATH walk can pick a Windows shim (`/mnt/c/.../codex`) over the Linux CLI or report a CLI the
 * guest cannot really run. Same mount rule as `buildPosixCommandPathLookupScript`'s
 * `skipWindowsMountDirs`: matched by mount type, since the automount root is configurable.
 */
import { existsSync, readFileSync } from 'node:fs'

const WINDOWS_DRIVE_MOUNT_TYPES = new Set(['drvfs', '9p', 'virtiofs'])

let cachedGuestMounts: readonly string[] | null = null

export function isWslGuestProcess(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  interopRegistered: () => boolean = () => existsSync('/proc/sys/fs/binfmt_misc/WSLInterop')
): boolean {
  if (platform !== 'linux') {
    return false
  }
  return Boolean(env.WSL_DISTRO_NAME?.trim() || env.WSL_INTEROP?.trim()) || interopRegistered()
}

/** `/proc/mounts` escapes whitespace and backslashes in a mount point as octal (`\040`). */
function decodeMountField(field: string): string {
  return field.replace(/\\([0-7]{3})/g, (_match, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8))
  )
}

export function parseWindowsDriveMountPoints(procMounts: string): string[] {
  const mounts: string[] = []
  for (const line of procMounts.split('\n')) {
    const [, mountPoint, type] = line.trim().split(/\s+/)
    const decoded = mountPoint ? decodeMountField(mountPoint).replace(/\/+$/, '') : ''
    // A root-level match would drop every PATH entry; no Windows drive mounts at `/`.
    if (decoded && type && WINDOWS_DRIVE_MOUNT_TYPES.has(type)) {
      mounts.push(decoded)
    }
  }
  return mounts
}

export function isUnderWindowsDriveMount(dir: string, mounts: readonly string[]): boolean {
  return mounts.some((mount) => dir === mount || dir.startsWith(`${mount}/`))
}

export function withoutWindowsDriveMountDirs(pathValue: string, mounts: readonly string[]): string {
  if (mounts.length === 0) {
    return pathValue
  }
  return pathValue
    .split(':')
    .filter((dir) => !isUnderWindowsDriveMount(dir.replace(/\/+$/, ''), mounts))
    .join(':')
}

/** This process's Windows drive mounts when it runs inside a WSL guest; empty everywhere else. */
export function readGuestWindowsDriveMounts(): readonly string[] {
  if (cachedGuestMounts) {
    return cachedGuestMounts
  }
  let mounts: string[] = []
  if (isWslGuestProcess()) {
    try {
      mounts = parseWindowsDriveMountPoints(readFileSync('/proc/mounts', 'utf8'))
    } catch {
      // Unreadable: keep PATH as is rather than guess which entries are Windows drives.
    }
  }
  cachedGuestMounts = mounts
  return mounts
}

/** @internal - tests need a fresh mount read. */
export function _resetGuestWindowsDriveMountsForTests(): void {
  cachedGuestMounts = null
}

/** `pathEnv` (default: this process's PATH) without Windows drive dirs on a WSL guest; as given
 *  elsewhere. For launch-time CLI resolution, which must pick the Linux CLI as detection did. */
export function guestNativePathEnv(
  pathEnv: string | null | undefined,
  mounts: readonly string[] = readGuestWindowsDriveMounts()
): string | null | undefined {
  if (mounts.length === 0) {
    return pathEnv
  }
  const value = pathEnv ?? process.env.PATH ?? null
  return value === null ? null : withoutWindowsDriveMountDirs(value, mounts)
}
