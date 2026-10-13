import { translate } from '@/i18n/i18n'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import type { SettingsSearchEntry } from './settings-search'

export const getChatPermissionSearchEntry = createLocalizedCatalog((): SettingsSearchEntry => ({
  targetSectionId: 'chat-permissions',
  title: translate('settings.chat.permissionsTitle', 'Default chat permissions'),
  description: translate(
    'settings.chat.permissionsDescription',
    'Applies to new chats and older chats with no saved permission choice. Saved chat choices and running replies keep their permissions. Terminal agents use Settings → Agents → Agent Permissions.'
  )
}))
