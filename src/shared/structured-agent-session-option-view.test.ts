import { describe, expect, it } from 'vitest'
import { CLAUDE_SESSION_OPTION_CATALOG } from './agent-session-option-catalog-claude-codex'
import {
  applyStructuredAgentSessionModelCatalog,
  createStructuredAgentSessionOptionState,
  settleStructuredAgentSessionBuiltinCatalog,
  structuredAgentSessionOptionSnapshot
} from './structured-agent-session-options'
import { structuredAgentSessionOptionView } from './structured-agent-session-option-view'

const levels = (...values: string[]) => values.map((value) => ({ value, label: value }))

function shown(...args: Parameters<typeof structuredAgentSessionOptionView>) {
  const snapshot = structuredAgentSessionOptionSnapshot(structuredAgentSessionOptionView(...args))
  const value = (id: string) => {
    const kind = snapshot.find((descriptor) => descriptor.id === id)?.kind
    return kind?.type === 'select' ? kind.currentValue : undefined
  }
  return { model: value('model'), effort: value('effort') }
}

describe('a new Claude chat whose remembered model the host list no longer offers', () => {
  const cold = createStructuredAgentSessionOptionState('claude', CLAUDE_SESSION_OPTION_CATALOG)
  const listed = applyStructuredAgentSessionModelCatalog(
    cold,
    CLAUDE_SESSION_OPTION_CATALOG,
    {
      origin: 'probe',
      fetchedAt: 1,
      models: [
        { id: 'sonnet', label: 'Sonnet', isDefault: false, efforts: levels('low', 'high') },
        { id: 'opus', label: 'Opus', isDefault: true, efforts: levels('low', 'high', 'xhigh') }
      ]
    },
    { newLaunch: true }
  )
  const seed = { model: 'gone', effort: 'max' }

  it('shows the listed default with the nearest effort it offers', () => {
    expect(shown(listed, seed, {})).toEqual({ model: 'opus', effort: 'xhigh' })
    // Derived only: the record never takes it.
    expect(listed.record.model).toBeUndefined()
  })

  it('keeps a listed model as remembered', () => {
    expect(shown(listed, { model: 'sonnet', effort: 'low' }, {})).toEqual({
      model: 'sonnet',
      effort: 'low'
    })
  })

  it('names nothing new while the host list is loading or failed', () => {
    expect(shown(cold, seed, {}).model).toBeUndefined()
    expect(shown(settleStructuredAgentSessionBuiltinCatalog(cold), seed, {}).model).toBeUndefined()
  })
})
