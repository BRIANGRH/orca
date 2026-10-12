import { describe, expect, it } from 'vitest'
import { CLAUDE_SESSION_OPTION_CATALOG } from './agent-session-option-catalog-claude-codex'
import type { AgentSessionModelCatalogResult } from './agent-session-wire'
import {
  applyStructuredAgentSessionModelCatalog,
  applyStructuredAgentSessionOptions,
  createStructuredAgentSessionOptionState,
  structuredAgentSessionOptionSnapshot
} from './structured-agent-session-options'
import {
  structuredAgentSessionListedPicks,
  structuredAgentSessionOptionView
} from './structured-agent-session-option-view'

const levels = (...values: string[]) => values.map((value) => ({ value, label: value }))
// Claude's session-less listing marks no default row.
const LISTED: AgentSessionModelCatalogResult = {
  origin: 'probe',
  fetchedAt: 1,
  models: [
    { id: 'opus[1m]', label: 'Opus', isDefault: false, efforts: levels('low', 'high', 'xhigh') },
    { id: 'sonnet', label: 'Sonnet', isDefault: false, efforts: levels('low', 'high') }
  ]
}

function shown(...args: Parameters<typeof structuredAgentSessionOptionView>) {
  const snapshot = structuredAgentSessionOptionSnapshot(structuredAgentSessionOptionView(...args))
  const value = (id: string) => {
    const kind = snapshot.find((descriptor) => descriptor.id === id)?.kind
    return kind?.type === 'select' ? kind.currentValue : undefined
  }
  return { model: value('model'), effort: value('effort') }
}

const cold = createStructuredAgentSessionOptionState('claude', CLAUDE_SESSION_OPTION_CATALOG)
const newChat = applyStructuredAgentSessionModelCatalog(
  cold,
  CLAUDE_SESSION_OPTION_CATALOG,
  LISTED,
  { newLaunch: true }
)
const remembered = { model: 'claude-gone', effort: 'max' }

describe('a Claude model the host list no longer offers', () => {
  it('shows a new chat on the first listed row, effort moved to the nearest level', () => {
    expect(shown(newChat, remembered, {}, LISTED)).toEqual({ model: 'opus[1m]', effort: 'xhigh' })
    expect(structuredAgentSessionListedPicks(newChat, remembered, {}, LISTED)).toEqual({
      model: 'opus[1m]',
      effort: 'xhigh'
    })
    // Derived only: the record never takes it.
    expect(newChat.record.model).toBeUndefined()
  })

  it('shows a stopped chat on the listed default too', () => {
    const fresh = createStructuredAgentSessionOptionState('claude', CLAUDE_SESSION_OPTION_CATALOG)
    const stopped = applyStructuredAgentSessionOptions(fresh, CLAUDE_SESSION_OPTION_CATALOG, {
      models: [
        ...LISTED.models,
        { id: 'claude-gone', label: 'claude-gone', isDefault: false, efforts: [] }
      ],
      current: { model: 'claude-gone', effort: 'high' }
    })
    expect(shown(stopped, undefined, {}, LISTED)).toEqual({ model: 'opus[1m]', effort: 'high' })
  })

  it('keeps a listed model, a held pick, and any model while no list has loaded', () => {
    expect(structuredAgentSessionListedPicks(newChat, { model: 'sonnet' }, {}, LISTED)).toBeNull()
    expect(
      structuredAgentSessionListedPicks(newChat, remembered, { model: 'sonnet' }, LISTED)
    ).toBeNull()
    expect(structuredAgentSessionListedPicks(newChat, remembered, {}, null)).toBeNull()
    expect(
      structuredAgentSessionListedPicks(newChat, remembered, {}, { origin: 'unknown' })
    ).toBeNull()
    // With no list, main's quiet placeholder names nothing.
    expect(shown(newChat, remembered, {}, null).model).toBeUndefined()
  })
})
