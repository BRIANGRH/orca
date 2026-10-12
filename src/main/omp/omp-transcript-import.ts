import { resolveOmpSessionsDir } from '../ai-vault/omp-session-root'
import { resolveSessionFilePath } from '../native-chat/session-file-resolver'
import { directoryTranscriptImport } from '../native-chat/structured-agent-cli-conversations'

export const OMP_TRANSCRIPT_IMPORT = directoryTranscriptImport({
  accountHomeCandidates: ({ selectedAccountHomePath }) => [selectedAccountHomePath],
  // Where OMP itself keeps the account's sessions, which is not always under it (XDG_DATA_HOME).
  findTranscript: async ({ providerSessionId, accountHomePath }) => {
    const sessionsDir = resolveOmpSessionsDir({
      env: { ...process.env, PI_CODING_AGENT_DIR: accountHomePath }
    })
    return sessionsDir
      ? resolveSessionFilePath('omp', providerSessionId, { ompSessionsDir: sessionsDir })
      : null
  }
})
