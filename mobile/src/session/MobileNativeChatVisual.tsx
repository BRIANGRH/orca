import { memo, useCallback, useMemo, useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import { ExternalLink } from 'lucide-react-native'
import type { NativeChatVisualDirective } from '../../../src/shared/native-chat-visual-directive'
import {
  createMobileFilePreviewHref,
  displayNameFromPreviewPath
} from '../files/mobile-file-preview-route'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import type { MobileNativeChatVisualSource } from './mobile-native-chat-visual-read'
import { MOBILE_NATIVE_CHAT_VISUAL_INITIAL_HEIGHT } from './mobile-native-chat-visual-host-document'
import { MobileNativeChatVisualFrame } from './MobileNativeChatVisualFrame'
import { useMobileNativeChatVisual } from './use-mobile-native-chat-visual'
import type { MobileNativeChatVisualRender } from './mobile-native-chat-visual-context'

const DEFAULT_TITLE = 'Visualization'

/** The quiet reserved space a visual takes while it loads. */
function MobileNativeChatVisualPlaceholder() {
  return (
    <View style={[styles.frame, styles.placeholder]}>
      <ActivityIndicator size="small" color={colors.textMuted} />
    </View>
  )
}

/** The transcript's visual renderer for a structured chat's source; null without one. */
export function useMobileNativeChatVisualRenderer(
  source: MobileNativeChatVisualSource | null
): MobileNativeChatVisualRender | null {
  return useMemo(
    () =>
      source
        ? (directive) => <MobileNativeChatVisual directive={directive} source={source} />
        : null,
    [source]
  )
}

/** A `::orca-visual{...}` line in a finished assistant reply: a workspace file that renders. */
export const MobileNativeChatVisual = memo(function MobileNativeChatVisual({
  directive,
  source
}: {
  directive: NativeChatVisualDirective
  source: MobileNativeChatVisualSource
}) {
  const { state, retry } = useMobileNativeChatVisual(source, directive.path)
  const router = useRouter()
  // A frame that navigated away or kept crashing; cleared by the reader's retry.
  const [frameFailed, setFrameFailed] = useState(false)
  const title = directive.title ?? DEFAULT_TITLE
  const onFrameFailed = useCallback(() => setFrameFailed(true), [])
  const onRetry = useCallback(() => {
    setFrameFailed(false)
    retry()
  }, [retry])
  // Opens like any workspace file the phone shows: in its file viewer.
  const onOpen = useCallback(() => {
    router.push(
      createMobileFilePreviewHref({
        hostId: source.hostId,
        worktreeId: source.worktreeId,
        source: 'worktree',
        relativePath: directive.path,
        name: displayNameFromPreviewPath(directive.path)
      })
    )
  }, [directive.path, router, source.hostId, source.worktreeId])

  if (state.kind === 'loading') {
    return <MobileNativeChatVisualPlaceholder />
  }
  if (state.kind === 'unavailable' || frameFailed) {
    return (
      <Pressable
        onPress={onRetry}
        accessibilityRole="button"
        accessibilityLabel="Visualization unavailable"
        accessibilityHint="Tries to load it again"
        style={styles.unavailable}
      >
        <Text style={styles.unavailableText}>Visualization unavailable</Text>
      </Pressable>
    )
  }
  return (
    <View style={styles.frame}>
      <MobileNativeChatVisualFrame
        html={state.html}
        title={title}
        mode="inline"
        onFailed={onFrameFailed}
      />
      <Pressable
        onPress={onOpen}
        accessibilityRole="button"
        accessibilityLabel={`Open ${title}`}
        hitSlop={8}
        style={styles.openButton}
      >
        <ExternalLink size={14} color={colors.textSecondary} strokeWidth={2.2} />
      </Pressable>
    </View>
  )
})

const styles = StyleSheet.create({
  frame: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    borderRadius: radii.row,
    marginBottom: spacing.sm,
    overflow: 'hidden'
  },
  placeholder: {
    height: MOBILE_NATIVE_CHAT_VISUAL_INITIAL_HEIGHT,
    alignItems: 'center',
    justifyContent: 'center'
  },
  unavailable: { marginBottom: spacing.sm, paddingVertical: spacing.xs },
  unavailableText: { color: colors.textMuted, fontSize: typography.metaSize },
  openButton: {
    position: 'absolute',
    top: spacing.xs,
    right: spacing.xs,
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bgPanel,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle
  }
})
