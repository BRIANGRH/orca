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
  nearestAgentEffort,
  structuredAgentSessionListedPicks,
  structuredAgentSessionOptionView
} from './structured-agent-session-option-view'

const levels = (...values: string[]) => values.map((value) => ({ value, label: value }))
const OPUS = { id: 'opus[1m]', label: 'Opus', isDefault: false, efforts: levels('low', 'xhigh') }
const SONNET = { id: 'sonnet', label: 'Sonnet', isDefault: false, efforts: levels('low', 'high') }
// Claude's session-less listing marks no default row.
const LISTED: AgentSessionModelCatalogResult = { origin: 'probe', fetchedAt: 1, models: [OPUS] }
const remembered = { model: 'claude-gone', effort: 'max' }

const fresh = () => createStructuredAgentSessionOptionState('claude', CLAUDE_SESSION_OPTION_CATALOG)
const withHostList = (state = fresh(), catalog: AgentSessionModelCatalogResult = LISTED) =>
  applyStructuredAgentSessionModelCatalog(state, CLAUDE_SESSION_OPTION_CATALOG, catalog, {
    newLaunch: true
  })
// A stopped chat's own answer lists the host's rows plus its own model, named by its id.
const stopped = (model: string, rows = [OPUS]) =>
  applyStructuredAgentSessionOptions(fresh(), CLAUDE_SESSION_OPTION_CATALOG, {
    models: [...rows, { id: model, label: model, isDefault: false, efforts: [] }],
    current: { model, effort: 'high' }
  })

function shown(...args: Parameters<typeof structuredAgentSessionOptionView>) {
  const snapshot = structuredAgentSessionOptionSnapshot(structuredAgentSessionOptionView(...args))
  const value = (id: string) => {
    const kind = snapshot.find((descriptor) => descriptor.id === id)?.kind
    return kind?.type === 'select' ? kind.currentValue : undefined
  }
  return { model: value('model'), effort: value('effort') }
}

describe('a Claude model the verified list no longer offers', () => {
  it('shows a new chat on the first listed row, effort moved to the nearest level', () => {
    const state = withHostList()
    expect(shown(state, remembered, {})).toEqual({ model: 'opus[1m]', effort: 'xhigh' })
    expect(structuredAgentSessionListedPicks(state, remembered, {})).toEqual({
      model: 'opus[1m]',
      effort: 'xhigh'
    })
    // Derived only: the record never takes it.
    expect(state.record.model).toBeUndefined()
  })

  it('shows a stopped chat on it too, its own unlisted row aside', () => {
    expect(shown(withHostList(stopped('claude-gone')), undefined, {})).toEqual({
      model: 'opus[1m]',
      effort: 'xhigh'
    })
  })

  it('keeps a model the list the picker shows offers, even one the host list lacks', () => {
    const live = withHostList(stopped('sonnet', [OPUS, SONNET]))
    expect(structuredAgentSessionListedPicks(live, undefined, {})).toBeNull()
    const held = { model: 'opus[1m]' }
    expect(structuredAgentSessionListedPicks(withHostList(), remembered, held)).toBeNull()
  })

  it.each<[string, AgentSessionModelCatalogResult]>([
    ['still listing', { ...LISTED, listingInProgress: true }],
    ['behind a failed sign-in', { ...LISTED, unavailable: { reason: 'notSignedIn' } }]
  ])('keeps the model while the list is %s', (_name, catalog) => {
    const state = withHostList(fresh(), catalog)
    expect(structuredAgentSessionListedPicks(state, remembered, {})).toBeNull()
    expect(
      structuredAgentSessionListedPicks(
        withHostList(stopped('claude-gone'), catalog),
        undefined,
        {}
      )
    ).toBeNull()
  })

  it('keeps the model before any host answer', () => {
    expect(structuredAgentSessionListedPicks(fresh(), remembered, {})).toBeNull()
    expect(structuredAgentSessionListedPicks(stopped('claude-gone'), undefined, {})).toBeNull()
  })
})

describe('nearestAgentEffort', () => {
  it('keeps an offered level, takes the higher on a tie, and names none it cannot rank', () => {
    expect(nearestAgentEffort('high', ['low', 'high'])).toBe('high')
    expect(nearestAgentEffort('medium', ['low', 'high'])).toBe('high')
    expect(nearestAgentEffort('max', ['low', 'xhigh'])).toBe('xhigh')
    expect(nearestAgentEffort('turbo', ['low', 'high'])).toBeUndefined()
  })
})
