import { useEffect, useMemo, useRef, useState } from 'react'
import { SquareArrowOutUpRight } from 'lucide-react'
import { ArtifactPublishButton } from '@/components/artifacts/ArtifactPublishButton'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { getConnectionIdFromState } from '@/lib/connection-context'
import { useAppStore } from '@/store'
import { NATIVE_CHAT_VISUAL_RESERVED_HEIGHT, NativeChatVisualFrame } from './NativeChatVisualFrame'
import { observeTranscriptVisibility } from './NativeChatTranscriptChrome'
import type { NativeChatFileLinkContext } from './native-chat-file-link'
import type { NativeChatVisualOwner } from './native-chat-visual-owner'
import { openNativeChatVisualFile } from './native-chat-visual-open'
import { useNativeChatFileLinkContext } from './use-native-chat-file-link-context'
import { useNativeChatFileLinkRecheckGeneration } from './use-native-chat-file-link-existence'
import {
  resolveNativeChatVisualFile,
  type NativeChatVisualDocument,
  type NativeChatVisualFile
} from './native-chat-visual-file'
import {
  nativeChatVisualArtifactSourceKey,
  readNativeChatVisualArtifactRequest
} from './native-chat-visual-share'
import { useNativeChatVisualDocument } from './use-native-chat-visual-document'

export function NativeChatVisualUnavailable(): React.JSX.Element {
  return (
    <p className="my-2 text-xs text-chat-foreground-faint">
      {translate('components.native-chat.visualUnavailable', 'Visualization unavailable')}
    </p>
  )
}

/**
 * A visual inside an assistant reply: a file link that renders, read through the chat's file-link
 * context. Its frame mounts once the reply scrolls near it and stays mounted, so what the reader
 * did in it survives scrolling away and back.
 */
export function NativeChatInlineVisual({
  owner,
  path,
  title
}: {
  owner: NativeChatVisualOwner
  path: string
  title: string | null
}): React.JSX.Element {
  const boxRef = useRef<HTMLDivElement | null>(null)
  const [near, setNear] = useState(false)
  const [retired, setRetired] = useState(false)
  // Null until a floating chat's folder is pinned: the placeholder shows and nothing is read.
  const fileLinkContext = useNativeChatFileLinkContext(owner.tabId)
  // Why the connection too: an SSH workspace's host can resolve after its context does.
  const connectionId = useAppStore((s) =>
    fileLinkContext ? getConnectionIdFromState(s, fileLinkContext.worktreeId) : null
  )
  const file = useMemo(
    () => (fileLinkContext ? resolveNativeChatVisualFile(fileLinkContext, path) : null),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- connectionId re-resolves the file's host.
    [fileLinkContext, path, connectionId]
  )
  const { state, showDocument } = useNativeChatVisualDocument(
    file,
    near && fileLinkContext !== null,
    useNativeChatFileLinkRecheckGeneration()
  )

  useEffect(() => {
    const element = boxRef.current
    if (!element || near) {
      return
    }
    return observeTranscriptVisibility(element, (visible) => {
      if (visible) {
        setNear(true)
      }
    })
  }, [near])

  if (retired || state.status === 'unavailable') {
    return <NativeChatVisualUnavailable />
  }
  const label = title ?? path

  return (
    <div ref={boxRef} className="group/visual relative my-3">
      {state.status === 'ready' && near ? (
        <>
          <NativeChatVisualFrame
            document={state.document}
            title={label}
            layout="inline"
            themeScope={boxRef}
            onRetired={() => setRetired(true)}
          />
          {fileLinkContext && file ? (
            <NativeChatInlineVisualToolbar
              path={path}
              fileLinkContext={fileLinkContext}
              file={file}
              showDocument={showDocument}
            />
          ) : null}
        </>
      ) : (
        <div
          role="status"
          aria-label={translate('components.native-chat.visualLoading', 'Loading visualization')}
          className="w-full rounded-md bg-muted/30"
          style={{ height: NATIVE_CHAT_VISUAL_RESERVED_HEIGHT }}
        />
      )}
    </div>
  )
}

/** Owns Share's open state, so it unmounts with the toolbar and a returning visual starts closed. */
function NativeChatInlineVisualToolbar({
  path,
  fileLinkContext,
  file,
  showDocument
}: {
  path: string
  fileLinkContext: NativeChatFileLinkContext
  file: NativeChatVisualFile
  showDocument: (document: NativeChatVisualDocument) => void
}): React.JSX.Element {
  // Share's popover is portalled and takes focus, so hover and focus-within can't hold the toolbar.
  const [shareOpen, setShareOpen] = useState(false)
  const openLabel = translate('components.native-chat.visualOpenInNewTab', 'Open in new tab')
  return (
    <div
      data-share-open={shareOpen}
      className="absolute top-2 right-2 flex items-center gap-0.5 rounded-md border border-border bg-background p-0.5 shadow-xs transition-opacity can-hover:opacity-0 group-hover/visual:opacity-100 focus-within:opacity-100 data-[share-open=true]:opacity-100"
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={openLabel}
            onClick={() => openNativeChatVisualFile(path, fileLinkContext)}
          >
            <SquareArrowOutUpRight />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          {openLabel}
        </TooltipContent>
      </Tooltip>
      <ArtifactPublishButton
        sourceKey={nativeChatVisualArtifactSourceKey(file)}
        createRequest={() => readNativeChatVisualArtifactRequest(file, showDocument)}
        open={shareOpen}
        onOpenChange={setShareOpen}
      />
    </div>
  )
}
