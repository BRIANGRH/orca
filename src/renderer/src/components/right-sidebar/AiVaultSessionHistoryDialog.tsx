import { useCallback, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { ShortcutKeyCombo } from '@/components/ShortcutKeyCombo'
import { translate } from '@/i18n/i18n'
import AiVaultPanel, { type AiVaultPanelHandle } from './AiVaultPanel'
import { readAgentSessionHistoryModalRequest } from './agent-session-history-modal'

/** `/resume`'s Session History: each opening mounts a fresh panel, apart from the sidebar's. */
export default function AiVaultSessionHistoryDialog(): React.JSX.Element | null {
  const modalData = useAppStore((s) => s.modalData)
  const closeModal = useAppStore((s) => s.closeModal)
  const panelRef = useRef<AiVaultPanelHandle>(null)
  const navigatedRef = useRef(false)
  // Why: the slot has no trigger element for the dialog to hand focus back to.
  const [returnFocusTo] = useState(() =>
    document.activeElement instanceof HTMLElement ? document.activeElement : null
  )
  const onSessionNavigated = useCallback(() => {
    navigatedRef.current = true
    closeModal()
  }, [closeModal])
  const request = readAgentSessionHistoryModalRequest(modalData)
  if (!request) {
    return null
  }
  const enterKey = navigator.userAgent.includes('Mac') ? '⏎' : 'Enter'
  return (
    <Dialog open onOpenChange={(open) => !open && closeModal()}>
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        surface="panel"
        className="flex h-[min(640px,calc(100vh-4rem))] flex-col overflow-hidden sm:max-w-[480px]"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          panelRef.current?.focusSearch()
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          // A resume or jump moved the user to another tab; the chat must not pull focus back.
          if (!navigatedRef.current && returnFocusTo?.isConnected) {
            returnFocusTo.focus({ preventScroll: true })
          }
        }}
        onEscapeKeyDown={(event) => {
          // Overlay dismissal runs before the search box sees Escape, so clear the search here.
          if (panelRef.current?.clearSearch()) {
            event.preventDefault()
          }
        }}
      >
        <DialogTitle className="sr-only">
          {translate(
            'auto.components.right.sidebar.AiVaultPanel.sessionHistory',
            'Agent Session History'
          )}
        </DialogTitle>
        <div className="min-h-0 flex-1">
          <AiVaultPanel
            ref={panelRef}
            workspace={request.workspace}
            initialQuery={request.initialQuery}
            onSessionNavigated={onSessionNavigated}
            headerAction={
              <DialogClose asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="size-6"
                  aria-label={translate('auto.components.ui.dialog.f26c4baeda', 'Close')}
                >
                  <X className="size-3" />
                </Button>
              </DialogClose>
            }
          />
        </div>
        <div className="flex shrink-0 items-center gap-3 border-t border-sidebar-border bg-sidebar px-3 py-1.5 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <ShortcutKeyCombo keys={['↑']} />
            <ShortcutKeyCombo keys={['↓']} />
            {translate('sessionHistory.dialog.select', 'Select')}
          </span>
          <span className="inline-flex items-center gap-1">
            <ShortcutKeyCombo keys={[enterKey]} />
            {translate('sessionHistory.dialog.open', 'Open')}
          </span>
        </div>
      </DialogContent>
    </Dialog>
  )
}
