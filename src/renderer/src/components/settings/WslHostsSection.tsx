import { useState } from 'react'
import { toast } from 'sonner'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { LoadingSpinner } from '../LoadingSpinner'
import { AddRemoteHostDialog, type AddRemoteHostMode } from '../sidebar/AddRemoteHostDialog'
import { useWslHostsEnabled } from '../sidebar/use-wsl-hosts-enabled'
import { getWslHostRowDetail } from '../sidebar/wsl-host-row-status'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'

/** Settings → Orca servers: the WSL distros added as hosts (Windows, experimental). */
export function WslHostsSection({
  environments,
  onChanged
}: {
  environments: readonly PublicKnownRuntimeEnvironment[]
  onChanged: () => void
}): React.JSX.Element | null {
  const enabled = useWslHostsEnabled()
  const statuses = useAppStore((s) => s.wslHostStatuses)
  const [dialogMode, setDialogMode] = useState<AddRemoteHostMode | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const hosts = environments.filter((environment) => environment.orcadDeployment?.kind === 'wsl')
  if (!enabled) {
    return null
  }

  const run = async (environmentId: string, action: 'connect' | 'remove'): Promise<void> => {
    const api = window.api.runtimeEnvironments?.wslHosts
    if (!api || busyId) {
      return
    }
    setBusyId(environmentId)
    try {
      await (action === 'connect' ? api.connect({ environmentId }) : api.remove({ environmentId }))
      onChanged()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="space-y-2" data-settings-section="wsl-hosts">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 space-y-0.5">
          <div className="flex items-center gap-2 text-sm font-medium">
            {translate('auto.components.settings.wslHosts.title', 'WSL hosts')}
            <Badge variant="outline">
              {translate('auto.components.settings.wslHosts.experimental', 'Experimental')}
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.wslHosts.description',
              'Orca runs a server inside each distro. A stopped distro starts only when you open one of its projects or connect it here.'
            )}
          </p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={() => setDialogMode('wsl')}>
          {translate('auto.components.settings.wslHosts.add', 'Add WSL distro')}
        </Button>
      </div>
      {hosts.length > 0 ? (
        <div className="divide-y divide-border rounded-md border border-border">
          {hosts.map((environment) => {
            const status = statuses[environment.id]
            const ready = status?.state === 'ready'
            const busy = busyId === environment.id
            return (
              <div key={environment.id} className="flex items-center gap-2 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{environment.name}</div>
                  <p className="truncate text-xs text-muted-foreground">
                    {getWslHostRowDetail(status)}
                    {status?.detail ? ` — ${status.detail}` : ''}
                  </p>
                </div>
                {ready ? null : (
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    disabled={busyId !== null || status?.state === 'connecting'}
                    onClick={() => void run(environment.id, 'connect')}
                  >
                    {busy ? <LoadingSpinner className="size-3" /> : null}
                    {translate('auto.components.settings.wslHosts.connect', 'Connect')}
                  </Button>
                )}
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  disabled={busyId !== null}
                  onClick={() => void run(environment.id, 'remove')}
                >
                  {translate('auto.components.settings.wslHosts.remove', 'Remove')}
                </Button>
              </div>
            )
          })}
        </div>
      ) : null}
      <AddRemoteHostDialog
        mode={dialogMode}
        onOpenChange={(mode) => {
          setDialogMode(mode)
          if (mode === null) {
            onChanged()
          }
        }}
      />
    </div>
  )
}
