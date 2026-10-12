/**
 * E2E only (`ORCA_E2E_FAKE_WSL_HOSTS`): stands in for wsl.exe so CI on any OS drives the WSL host
 * UI against a headless Orca server. Each "distro" connects straight to that server's pairing.
 */
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { parsePairingCode } from '../../shared/pairing'
import type { WslHostConnector } from './wsl-host-service'
import type { WslOrcadConnection, WslOrcadConnectionDependencies } from './wsl-orcad-connection'
import { defaultWslOrcadEnvironmentId } from './wsl-orcad-deploy'

const FakeDistrosSchema = z.array(
  z.object({
    name: z.string().min(1),
    state: z.enum(['running', 'stopped']),
    version: z.union([z.literal(1), z.literal(2)])
  })
)

const FakeWslHostsSchema = z.object({
  distros: FakeDistrosSchema,
  /** Re-read on every listing, so a test can register a distro while the app runs. */
  distrosFile: z.string().optional(),
  pairingCode: z.string().min(1),
  /** `missing` stands in for a build shipped without the orcad template. */
  serverFiles: z.enum(['present', 'missing']).optional()
})

export function readFakeWslHostsConfig(
  raw = process.env.ORCA_E2E_FAKE_WSL_HOSTS
): z.infer<typeof FakeWslHostsSchema> | null {
  if (!raw) {
    return null
  }
  return FakeWslHostsSchema.parse(JSON.parse(raw))
}

export function createFakeWslHostConnector(
  config: z.infer<typeof FakeWslHostsSchema>,
  onChange: NonNullable<WslOrcadConnectionDependencies['onChange']>
): WslHostConnector {
  const offer = parsePairingCode(config.pairingCode)
  const port = offer ? Number(new URL(offer.endpoint).port) : 0
  const active = new Map<string, WslOrcadConnection>()
  const key = (distro: string): string => distro.toLowerCase()
  return {
    listDistros: async () =>
      (config.distrosFile
        ? FakeDistrosSchema.parse(JSON.parse(readFileSync(config.distrosFile, 'utf8')))
        : config.distros
      ).map((distro, index) => ({
        ...distro,
        id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`
      })),
    readOrcadPublicKey: async () => null,
    connect: async (distro) => {
      onChange(distro, null, { state: 'connecting' })
      const connection: WslOrcadConnection = {
        distro,
        environmentId: defaultWslOrcadEnvironmentId(distro),
        localPort: port,
        remotePort: port,
        fullVersion: 'e2e',
        pid: null,
        pairingOffer: config.pairingCode,
        close: async () => {
          active.delete(key(distro))
        }
      }
      active.set(key(distro), connection)
      onChange(distro, connection, { state: 'ready', census: null })
      return connection
    },
    get: (distro) => active.get(key(distro)) ?? null,
    disconnect: async (distro) => {
      if (active.delete(key(distro))) {
        onChange(distro, null, { state: 'closed' })
      }
    },
    stopServer: async (distro) => {
      if (active.delete(key(distro))) {
        onChange(distro, null, { state: 'closed' })
      }
      return { stopped: true }
    },
    releaseHolder: async () => {},
    adoptHolders: async () => {},
    dispose: async () => {
      active.clear()
    }
  }
}
