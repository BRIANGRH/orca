import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { WslHostDistro } from '../../../../shared/wsl-host-types'
import { AddWslHostFormPanel, canAddWslDistro } from './AddWslHostFormPanel'
import { useWslHostServerFilesMissing } from './use-wsl-hosts-enabled'

/** The "Add WSL distro" step of the add-host dialog; mounted only while it shows. */
export function AddWslHostDialogBody({
  adding,
  onAddingChange,
  onAdded,
  onCancel
}: {
  adding: boolean
  onAddingChange: (adding: boolean) => void
  onAdded: () => void
  onCancel: () => void
}): React.JSX.Element {
  const [distros, setDistros] = useState<WslHostDistro[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedDistro, setSelectedDistro] = useState('')
  const [error, setError] = useState<string | null>(null)
  const serverFilesMissing = useWslHostServerFilesMissing()
  const setRuntimeEnvironments = useAppStore((s) => s.setRuntimeEnvironments)
  const readRuntimeHostStatusSnapshots = useAppStore((s) => s.readRuntimeHostStatusSnapshots)

  useEffect(() => {
    const api = window.api.runtimeEnvironments?.wslHosts
    let ignore = false
    void (api?.listDistros() ?? Promise.resolve([]))
      .then((list) => {
        if (ignore) {
          return
        }
        setDistros(list)
        // Why: preselect only when exactly one distro can be added, so a choice is never implied.
        const addable = list.filter(canAddWslDistro)
        if (addable.length === 1) {
          setSelectedDistro(addable[0].name)
        }
      })
      .catch((cause: unknown) => {
        if (!ignore) {
          setError(cause instanceof Error ? cause.message : String(cause))
        }
      })
      .finally(() => {
        if (!ignore) {
          setLoading(false)
        }
      })
    return () => {
      ignore = true
    }
  }, [])

  const add = async (): Promise<void> => {
    const api = window.api.runtimeEnvironments?.wslHosts
    const selected = distros.find((distro) => distro.name === selectedDistro)
    if (!api || !selected || !canAddWslDistro(selected)) {
      return
    }
    setError(null)
    onAddingChange(true)
    try {
      // Why startIfStopped: the button said "Start and add", so this click is the user's consent.
      const result = await api.add({
        distro: selected.name,
        startIfStopped: selected.state === 'stopped'
      })
      if (!result.ok) {
        setError(result.message)
        return
      }
      setRuntimeEnvironments(await window.api.runtimeEnvironments.list())
      await readRuntimeHostStatusSnapshots()
      toast.success(
        translate('auto.components.sidebar.AddWslHostDialogBody.added', '{{value0}} added.', {
          value0: selected.name
        })
      )
      onAdded()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      onAddingChange(false)
    }
  }

  return (
    <AddWslHostFormPanel
      distros={distros}
      loading={loading}
      selectedDistro={selectedDistro}
      error={error}
      adding={adding}
      serverFilesMissing={serverFilesMissing}
      onSelectDistro={(name) => {
        setSelectedDistro(name)
        setError(null)
      }}
      onSubmit={() => void add()}
      onCancel={onCancel}
    />
  )
}
