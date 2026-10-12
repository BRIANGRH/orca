import { join } from 'node:path'
import { resolveGrokHomeDir } from '../../shared/grok-session-paths'
import { resolveSessionFilePath } from '../native-chat/session-file-resolver'
import { directoryTranscriptImport } from '../native-chat/structured-agent-cli-conversations'

export const GROK_TRANSCRIPT_IMPORT = directoryTranscriptImport({
  // The chat's own home, then the one Session History lists Grok's conversations from.
  accountHomeCandidates: ({ selectedAccountHomePath }) => [
    selectedAccountHomePath,
    resolveGrokHomeDir()
  ],
  findTranscript: ({ providerSessionId, accountHomePath }) =>
    resolveSessionFilePath('grok', providerSessionId, {
      grokSessionsDir: join(accountHomePath, 'sessions')
    })
})
