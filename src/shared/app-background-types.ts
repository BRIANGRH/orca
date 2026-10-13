import type { AppBackgroundScope } from './app-background-settings'

export type AppBackgroundGlobalSettings = {
  /** Main-owned `<uuid>.<ext>` under userData/appearance; written only by appBackground:commit. */
  appBackgroundImageId?: string | null
  appBackgroundScope?: AppBackgroundScope
  appBackgroundImageOpacity?: number
  appBackgroundBlur?: number
  /** Chrome surface opacity; only applies while a background image is set. */
  appBackgroundPanelOpacity?: number
}

export type AppBackgroundPickRejection =
  | 'tooLarge'
  | 'unsupportedType'
  | 'unreadable'
  | 'saveFailed'

export type AppBackgroundPickResult =
  | { status: 'picked'; stagingId: string }
  | { status: 'canceled' }
  | { status: 'rejected'; reason: AppBackgroundPickRejection }

export type AppBackgroundReadArgs = {
  id: string
  /** True for a picked-but-unapplied image in the staging directory. */
  staging?: boolean
}

export type AppBackgroundCommitArgs = {
  /** Staging id to apply, or null to remove the background image. */
  stagingId: string | null
}

export type AppBackgroundCommitResult =
  | { ok: true; imageId: string | null }
  | { ok: false; reason: 'invalidId' | 'stagingMissing' | 'saveFailed' }
